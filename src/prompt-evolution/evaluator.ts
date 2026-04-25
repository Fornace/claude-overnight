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
import { scoreOutput, gmean, aggregateReps, bootstrapCI, kendallTau } from "./scorer.js";
import { type JudgeOpts } from "./llm-judge.js";
import {
  defaultCallModel,
  attemptJsonParse,
  type CallModel,
  type CallModelOpts,
} from "./transport.js";
import { averageDimensions } from "./evaluator-utils.js";
import { runJudge } from "./evaluator-judge.js";
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
  /**
   * Adaptive sampling: after initial `repetitions`, keep adding one rep per cell
   * where any score-dim σ exceeds `threshold`, up to `cap` total reps. Prevents
   * wasted reps on already-stable cells while driving noisy ones down.
   */
  adaptiveReps?: { cap: number; threshold?: number };
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
  const concurrency = opts.concurrency ?? 8;
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

  // Work-stealing pool: keep `concurrency` jobs in flight so a slow call
  // doesn't block the others in its slice.
  const rawByKey = new Map<string, EvaluationResult[]>();
  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      const r = await runSingle(jobs[i], opts, transport);
      const key = `${r.variantId}:${r.caseHash}:${r.model ?? ""}`;
      const arr = rawByKey.get(key) ?? [];
      arr.push(r);
      rawByKey.set(key, arr);
      done++;
      opts.onProgress?.(done, jobs.length, r.caseName, r.variantId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  // Adaptive sampling: for cells where any score-dim σ exceeds threshold,
  // add one more rep and rerun — up to `cap` total reps. Converges on a
  // stable estimate without wasting reps on already-stable cells.
  if (opts.adaptiveReps) {
    const cap = opts.adaptiveReps.cap;
    const threshold = opts.adaptiveReps.threshold ?? 0.1;
    for (let round = 0; round < cap - reps; round++) {
      const extra: EvalJob[] = [];
      for (const v of variants) {
        for (const c of cases) {
          for (const model of models) {
            const key = `${v.id}:${c.hash}:${model}`;
            const runs = rawByKey.get(key) ?? [];
            if (runs.length >= cap) continue;
            const { stddev } = aggregateReps(runs);
            const dims: Array<keyof ScoreDimensions> = ["parse", "schema", "content", "costEfficiency", "speed"];
            const maxSigma = Math.max(...dims.map((d) => stddev[d]));
            if (maxSigma > threshold) {
              extra.push({ case: c, variantId: v.id, text: v.text, systemText: c.systemPrompt, model, rep: runs.length });
            }
          }
        }
      }
      if (extra.length === 0) break;
      opts.onProgress?.(jobs.length, jobs.length + extra.length, "adaptive", `round ${round + 1}`);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const i = next++;
          if (i >= extra.length) return;
          const r = await runSingle(extra[i], opts, transport);
          const key = `${r.variantId}:${r.caseHash}:${r.model ?? ""}`;
          const arr = rawByKey.get(key) ?? [];
          arr.push(r);
          rawByKey.set(key, arr);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, extra.length) }, worker));
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

    // Rep-level stddev of gmean across all per-cell results for this variant.
    // Fills the `σ gmean` report column in single-model runs, which previously
    // always showed "—" because the column was tied to crossModelStddev.
    let repsStddev: number | undefined;
    if (reps > 1) {
      const cellStddevs: number[] = [];
      for (const r of rowResults.values()) {
        if (r.stddev) {
          // Use the stddev of gmean-per-rep if we had the reps at hand; since
          // we've already collapsed, approximate with gmean of the per-dim stddevs.
          cellStddevs.push(gmean(r.stddev));
        }
      }
      if (cellStddevs.length > 0) {
        repsStddev = cellStddevs.reduce((a, b) => a + b, 0) / cellStddevs.length;
      }
    }

    // Bootstrap CI over per-case gmean samples — if two variants' CIs overlap,
    // the ranking between them is not reliable.
    let gmeanCI: [number, number] | undefined;
    if (allScores.length >= 2) {
      const perCaseGmeans = [...rowResults.values()].map((r) => gmean(r.scores));
      gmeanCI = bootstrapCI(perCaseGmeans, 500);
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
      repsStddev,
      gmeanCI,
    });
  }

  // Rank-order stability: split reps in half per cell, compute per-variant
  // gmeans for each half, rank variants, compare with Kendall τ. τ ≥ 0.7
  // means the ranking is trustworthy; lower than that means the benchmark
  // can't reliably order these variants.
  if (reps >= 4) {
    const halfA = halfSplitMatrix(variants, cases, models, rawByKey, 0);
    const halfB = halfSplitMatrix(variants, cases, models, rawByKey, 1);
    if (halfA.length >= 2 && halfB.length >= 2) {
      const tau = kendallTau(halfA, halfB);
      for (const row of rows) row.rankStability = tau;
    }
  }

  return rows;
}

/**
 * Return a variant ranking computed from only half of the reps (even or odd).
 * Used to measure whether the same reps split two ways agree on the order.
 */
function halfSplitMatrix(
  variants: Array<{ id: string }>,
  cases: BenchmarkCase[],
  models: string[],
  rawByKey: Map<string, EvaluationResult[]>,
  side: 0 | 1,
): string[] {
  const scored: Array<{ id: string; g: number }> = [];
  for (const v of variants) {
    const dims: ScoreDimensions[] = [];
    for (const c of cases) {
      for (const m of models) {
        const key = `${v.id}:${c.hash}:${m}`;
        const runs = rawByKey.get(key) ?? [];
        const half = runs.filter((_, i) => i % 2 === side);
        if (half.length === 0) continue;
        dims.push(aggregateReps(half).mean);
      }
    }
    if (dims.length > 0) scored.push({ id: v.id, g: gmean(averageDimensions(dims)) });
  }
  scored.sort((a, b) => b.g - a.g);
  return scored.map((s) => s.id);
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

/** Render a prompt variant given its source path and optional variant name */
export function renderVariant(promptPath: string, variant: string | undefined, vars: PromptVars): string {
  return renderPrompt(promptPath, { variant, vars });
}
