/**
 * LLM-judge pass over a built evaluation matrix.
 *
 * Split out of evaluator.ts to keep each file under the 500-line cap and
 * because the judge has its own concerns (top-N eligibility, batch vs
 * online path, crash-resumable state).
 *
 * The judge REPLACES the heuristic content score with a semantic grade.
 * We only judge top-N variants per generation to cap cost — a judge call
 * per (variant, case, model) on a large population explodes fast.
 */

import { judgeOutput, buildJudgePrompt, parseJudgeOutput, type JudgeOpts } from "./llm-judge.js";
import { batchCallModel, type BatchJob } from "./transport-batch.js";
import { saveBatchState, loadBatchState, markBatchFinished } from "./persistence.js";
import { gmean } from "./scorer.js";
import { averageDimensions } from "./evaluator-utils.js";
import type { BenchmarkCase, EvaluationResult, ScoreDimensions } from "./types.js";
import type { EvalOpts } from "./evaluator.js";

export async function runJudge(
  variants: Array<{ id: string; text: string }>,
  cases: BenchmarkCase[],
  models: string[],
  aggregated: Map<string, EvaluationResult>,
  judge: JudgeOpts & { topN?: number },
  opts: EvalOpts,
): Promise<void> {
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

  const cells: Array<{ key: string; c: BenchmarkCase; r: EvaluationResult }> = [];
  for (const v of variants) {
    if (!eligible.has(v.id)) continue;
    for (const c of cases) {
      for (const model of models) {
        const key = `${v.id}:${c.hash}:${model}`;
        const r = aggregated.get(key);
        if (!r || r.scores.parse < 0.5) continue; // unparseable output isn't worth judging
        cells.push({ key, c, r });
      }
    }
  }
  if (cells.length === 0) return;

  if (opts.batch) {
    await runJudgeBatch(cells, judge, opts);
    return;
  }

  const jobs: Array<() => Promise<void>> = cells.map((cell) => async () => {
    try {
      const jr = await judgeOutput(cell.r.rawOutput, cell.c, judge);
      cell.r.scores = { ...cell.r.scores, content: jr.score };
      cell.r.judgeJustification = jr.justification;
    } catch {
      // Judge failure is non-fatal — keep heuristic content.
    }
  });

  const judgeConcurrency = 3;
  let nextJob = 0;
  const judgeWorker = async (): Promise<void> => {
    while (true) {
      const i = nextJob++;
      if (i >= jobs.length) return;
      await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(judgeConcurrency, jobs.length) }, judgeWorker));
}

async function runJudgeBatch(
  cells: Array<{ key: string; c: BenchmarkCase; r: EvaluationResult }>,
  judge: JudgeOpts & { topN?: number },
  opts: EvalOpts,
): Promise<void> {
  const batchJobs: BatchJob[] = cells.map((cell, i) => ({
    customId: `j:${i}|k:${cell.key}`,
    userText: buildJudgePrompt(cell.r.rawOutput, cell.c),
    model: judge.model,
  }));
  const existing = opts.runId != null && opts.generation != null
    ? loadBatchState(opts.runId, opts.generation, "judge")
    : null;
  const transport = opts.batchCallModel ?? batchCallModel;
  const results = await transport(batchJobs, {
    baseUrl: judge.baseUrl ?? opts.baseUrl,
    authToken: judge.authToken ?? opts.authToken,
    maxTokens: judge.maxTokens ?? 2048,
    resumeBatchId: existing?.batchId,
    onSubmitted: (batchId, p) => {
      if (opts.runId != null && opts.generation != null && !existing) {
        saveBatchState(opts.runId, {
          generation: opts.generation,
          phase: "judge",
          batchId,
          provider: p as "anthropic" | "openai-compatible",
          submittedAt: new Date().toISOString(),
        });
      }
      opts.onBatchProgress?.(`judge batch submitted: ${batchId} (${p})`);
    },
    onProgress: (p) => opts.onBatchProgress?.(`judge batch ${p.batchId} ${p.phase}${p.succeeded != null ? `: ${p.succeeded}/${p.total ?? batchJobs.length}` : ""}`),
  });
  if (opts.runId != null && existing) markBatchFinished(opts.runId, existing.batchId);

  for (const cell of cells) {
    const customId = batchJobs.find((b) => b.customId.includes(`|k:${cell.key}`))?.customId;
    const got = customId ? results.get(customId) : undefined;
    if (!got || !got.raw) continue;
    try {
      const jr = parseJudgeOutput(got.raw);
      cell.r.scores = { ...cell.r.scores, content: jr.score };
      cell.r.judgeJustification = jr.justification;
    } catch {
      // Judge parse failure is non-fatal — keep heuristic content.
    }
  }
}
