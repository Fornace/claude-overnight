/**
 * Evaluation matrix runner.
 *
 * rows    = variants
 * columns = cases (optionally × models)
 * cells   = EvaluationResult with multi-dimensional scores
 *
 * Repetitions (N) give us a noise floor: the same (variant, case) is run N
 * times and results aggregate to mean + stddev. Without this we can't tell
 * whether 56.7 vs 37.4 is signal or variance.
 *
 * Multi-model runs (models[].length > 1) give us cross-model stddev: a
 * prompt that only works on one generator is fragile.
 *
 * All HTTP calls go through `transport.callModel` so tests can inject a
 * deterministic mock (see prompt-evolution-discrimination.test.ts).
 */

import { renderPrompt } from "../prompts/load.js";
import { scoreOutput, gmean, aggregateReps } from "./scorer.js";
import { judgeOutput, type JudgeOpts } from "./llm-judge.js";
import {
  defaultCallModel,
  attemptJsonParse,
  type CallModel,
  type CallModelOpts,
} from "./transport.js";
import type { BenchmarkCase, VariantRow, EvaluationResult, PromptVars, ScoreDimensions } from "./types.js";

export interface EvalOpts {
  /** Primary generator model (retained for single-model compat). */
  model: string;
  /** Multiple generator models — enables cross-model scoring. Overrides `model` when ≥2 entries. */
  models?: string[];
  /** Base URL for the API endpoint */
  baseUrl?: string;
  /** Auth token */
  authToken?: string;
  /** Max tokens per evaluation */
  maxTokens?: number;
  /** Concurrency for parallel case evaluation */
  concurrency?: number;
  /** Per-call HTTP timeout. Defaults to 120s — bad endpoints can hang otherwise. */
  timeoutMs?: number;
  /** Repetitions per (variant, case, model). Default 1 — opt-in to 3+ for noise floor. */
  repetitions?: number;
  /** Inject an llm-judge call per case; content dimension is replaced by judge score. */
  judge?: JudgeOpts & { topN?: number };
  /** Transport override for tests. */
  callModel?: CallModel;
  /** Optional callback for progress */
  onProgress?: (done: number, total: number, caseName: string, variantId: string) => void;
}

interface EvalJob {
  case: BenchmarkCase;
  variantId: string;
  text: string;
  systemText?: string;
  model: string;
  rep: number;
}

export async function buildMatrix(
  variants: Array<{ id: string; promptPath: string; generation: number; text: string }>,
  cases: BenchmarkCase[],
  opts: EvalOpts,
): Promise<VariantRow[]> {
  const models = opts.models && opts.models.length > 0 ? opts.models : [opts.model];
  const reps = Math.max(1, opts.repetitions ?? 1);
  const concurrency = opts.concurrency ?? 4;
  const transport = opts.callModel ?? defaultCallModel;

  // Build the full job list: (variant × case × model × rep).
  const jobs: EvalJob[] = [];
  for (const v of variants) {
    for (const c of cases) {
      for (const model of models) {
        for (let r = 0; r < reps; r++) {
          jobs.push({ case: c, variantId: v.id, text: v.text, systemText: c.systemPrompt, model, rep: r });
        }
      }
    }
  }

  // Raw results, keyed by variant:case:model, each an array of per-rep results.
  const rawByKey = new Map<string, EvaluationResult[]>();
  let done = 0;
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((job) => runSingle(job, opts, transport)));
    for (const r of batchResults) {
      const key = `${r.variantId}:${r.caseHash}:${r.model ?? ""}`;
      const arr = rawByKey.get(key) ?? [];
      arr.push(r);
      rawByKey.set(key, arr);
      done++;
      opts.onProgress?.(done, jobs.length, r.caseName, r.variantId);
    }
  }

  // Collapse reps: one aggregated EvaluationResult per (variant, case, model).
  const aggregated = new Map<string, EvaluationResult>();
  for (const [key, runs] of rawByKey) {
    aggregated.set(key, collapseReps(runs));
  }

  // Optional llm-judge pass on top-N variants (by current heuristic content).
  if (opts.judge) await runJudge(variants, cases, models, aggregated, opts.judge);

  // Assemble rows: per-variant aggregate across all cases and models.
  const rows: VariantRow[] = [];
  for (const v of variants) {
    const rowResults = new Map<string, EvaluationResult>();
    const perModel: Record<string, ScoreDimensions> = {};
    const modelGmeans: number[] = [];
    let parseFailures = 0;

    for (const model of models) {
      const modelScores: ScoreDimensions[] = [];
      for (const c of cases) {
        const key = `${v.id}:${c.hash}:${model}`;
        const r = aggregated.get(key);
        if (!r) continue;
        rowResults.set(models.length > 1 ? `${c.hash}:${model}` : c.hash, r);
        modelScores.push(r.scores);
        if (r.scores.parse < 0.5) parseFailures++;
      }
      if (modelScores.length > 0) {
        const modelAgg = averageDimensions(modelScores);
        perModel[model] = modelAgg;
        modelGmeans.push(gmean(modelAgg));
      }
    }

    const allScores = [...rowResults.values()].map((r) => r.scores);
    const aggregate = averageDimensions(allScores);
    const g = gmean(aggregate);

    let crossModelStddev: number | undefined;
    if (modelGmeans.length > 1) {
      const m = modelGmeans.reduce((a, b) => a + b, 0) / modelGmeans.length;
      const variance = modelGmeans.reduce((a, b) => a + (b - m) ** 2, 0) / modelGmeans.length;
      crossModelStddev = Math.sqrt(variance);
    }

    rows.push({
      variantId: v.id,
      promptPath: v.promptPath,
      generation: v.generation,
      text: v.text,
      results: rowResults,
      aggregate,
      gmean: g,
      crossModelStddev,
      perModel: models.length > 1 ? perModel : undefined,
      parseFailures,
    });
  }

  return rows;
}

async function runSingle(job: EvalJob, opts: EvalOpts, transport: CallModel): Promise<EvaluationResult> {
  const started = Date.now();
  const callOpts: CallModelOpts = {
    model: job.model,
    baseUrl: opts.baseUrl,
    authToken: opts.authToken,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
  };

  try {
    const { raw, costUsd } = await transport(job.text, job.systemText, callOpts);
    const durationMs = Date.now() - started;
    const parsed = attemptJsonParse(raw);
    const scored = scoreOutput(raw, parsed, costUsd, durationMs, job.case, { model: job.model });
    scored.variantId = job.variantId;
    return scored;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    return {
      caseHash: job.case.hash,
      caseName: job.case.name,
      variantId: job.variantId,
      promptPath: job.case.promptPath,
      rawOutput: msg,
      parsedOutput: null,
      costUsd: 0,
      durationMs,
      scores: { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 },
      notes: [`HTTP/fetch error: ${msg.slice(0, 200)}`],
      model: job.model,
    };
  }
}

/** Collapse N repetitions into a single EvaluationResult carrying mean + stddev. */
function collapseReps(runs: EvaluationResult[]): EvaluationResult {
  if (runs.length === 1) return runs[0];
  const { mean, stddev } = aggregateReps(runs);
  // Pick the median-quality run as the "representative" raw output, so the
  // report shows a realistic sample rather than the best or worst rep.
  const sorted = [...runs].sort((a, b) => gmean(a.scores) - gmean(b.scores));
  const mid = sorted[Math.floor(sorted.length / 2)];
  return {
    ...mid,
    scores: mean,
    stddev,
    reps: runs.length,
  };
}

async function runJudge(
  variants: Array<{ id: string; text: string }>,
  cases: BenchmarkCase[],
  models: string[],
  aggregated: Map<string, EvaluationResult>,
  judge: JudgeOpts & { topN?: number },
): Promise<void> {
  // Judge only the top-N variants to cap cost: a judge call per
  // (variant, case, model) on a large population blows up fast.
  const topN = judge.topN ?? 4;
  const variantGmeans = variants.map((v) => {
    const scores: ScoreDimensions[] = [];
    for (const c of cases) {
      for (const model of models) {
        const r = aggregated.get(`${v.id}:${c.hash}:${model}`);
        if (r) scores.push(r.scores);
      }
    }
    return { id: v.id, g: scores.length > 0 ? gmean(averageDimensions(scores)) : 0 };
  });
  variantGmeans.sort((a, b) => b.g - a.g);
  const eligible = new Set(variantGmeans.slice(0, topN).map((x) => x.id));

  const jobs: Array<() => Promise<void>> = [];
  for (const v of variants) {
    if (!eligible.has(v.id)) continue;
    for (const c of cases) {
      for (const model of models) {
        const key = `${v.id}:${c.hash}:${model}`;
        const r = aggregated.get(key);
        if (!r || r.scores.parse < 0.5) continue; // no point judging unparseable output
        jobs.push(async () => {
          try {
            const jr = await judgeOutput(r.rawOutput, c, judge);
            r.scores = { ...r.scores, content: jr.score };
            r.judgeJustification = jr.justification;
          } catch {
            // Judge failure is non-fatal — keep heuristic content.
          }
        });
      }
    }
  }

  // Run judge calls with modest concurrency to stay under provider rate limits.
  const concurrency = 3;
  for (let i = 0; i < jobs.length; i += concurrency) {
    await Promise.all(jobs.slice(i, i + concurrency).map((fn) => fn()));
  }
}

function averageDimensions(scores: ScoreDimensions[]): ScoreDimensions {
  if (scores.length === 0) return { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 };
  const n = scores.length;
  return {
    parse: scores.reduce((a, b) => a + b.parse, 0) / n,
    schema: scores.reduce((a, b) => a + b.schema, 0) / n,
    content: scores.reduce((a, b) => a + b.content, 0) / n,
    costEfficiency: scores.reduce((a, b) => a + b.costEfficiency, 0) / n,
    speed: scores.reduce((a, b) => a + b.speed, 0) / n,
  };
}

/** Render a prompt variant given its source path and optional variant name */
export function renderVariant(promptPath: string, variant: string | undefined, vars: PromptVars): string {
  return renderPrompt(promptPath, { variant, vars });
}
