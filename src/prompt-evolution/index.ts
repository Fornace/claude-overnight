/**
 * Prompt evolution orchestration.
 *
 * Usage (programmatic):
 *   import { evolvePrompt } from "./prompt-evolution/index.js";
 *   await evolvePrompt({
 *     promptPath: "10_planning/10-3_plan",
 *     cases: PLAN_CASES,
 *     model: "claude-haiku-4-5",
 *     generations: 3,
 *   });
 *
 * The loop:
 *   1. Seed population from existing prompt variants (TIGHT, STANDARD, LARGE)
 *   2. Evaluate all variants against all cases → matrix
 *   3. Curate: keep elites + diverse variants
 *   4. Mutate worst-performing variants using failure traces
 *   5. Repeat
 */

import { renderPrompt } from "../prompts/load.js";
import { buildMatrix, renderVariant, type EvalOpts } from "./evaluator.js";
import type { JudgeOpts } from "./llm-judge.js";
import { mutate } from "./mutator.js";
import { curate, formatMatrix, type CurateOpts } from "./curator.js";
import { initRun, appendMatrix, appendLearning, snapshotPrompts, finalizeRun } from "./persistence.js";
import { generateReport } from "./report.js";
import type {
  BenchmarkCase,
  VariantRow,
  MutationRequest,
  LearningEntry,
  EvolutionResult,
} from "./types.js";

export interface EvolveOpts {
  /** Prompt file path, e.g. "10_planning/10-3_plan" or "mcp-browser/planning" */
  promptPath: string;
  /** Benchmark cases to evaluate against */
  cases: BenchmarkCase[];
  /** Model for evaluation (fast/cheap) */
  evalModel: string;
  /** Model for mutation (can be smarter) */
  mutateModel?: string;
  /** Number of evolution generations */
  generations?: number;
  /** Population size cap */
  populationCap?: number;
  /** Stop early if no improvement for N generations (default: 3) */
  plateauGenerations?: number;
  /** Current canon gmean (0 if none) */
  canonGmean?: number;
  /** Optional logging callback */
  onLog?: (text: string) => void;
  /** Base URL override */
  baseUrl?: string;
  /** Auth token override */
  authToken?: string;
  /** Optional seed prompt text (for non-file prompts like MCP-browser) */
  seedText?: string;
  /** Target project label for persistence */
  target?: string;
  /** Run ID override (auto-generated if omitted) */
  runId?: string;
  /** Extra eval models for cross-model variance. If set, every case runs on each model. */
  evalModels?: string[];
  /** Repetitions per (variant, case, model). Default 1. Recommended ≥3 for noise floor. */
  repetitions?: number;
  /** Max in-flight eval calls. Default 8. Raise for slow endpoints, lower for strict rate limits. */
  concurrency?: number;
  /** Use provider batch API instead of online calls. 50% cheaper, slower wall-clock. */
  batch?: boolean;
  /** Override base URL for batch submissions only. */
  batchBaseUrl?: string;
  /** Override auth token for batch submissions only. */
  batchAuthToken?: string;
  /** Override model for batch submissions (e.g. kimi-k2.6 when online uses kimi-for-coding). */
  batchModel?: string;
  /** Adaptive sampling cap (opt-in). Keeps adding reps to noisy cells up to this count. */
  adaptiveReps?: { cap: number; threshold?: number };
  /**
   * Fraction of cases to hold out for a post-evolution validation eval.
   * When > 0 and < 1: evolution (mutation + curation) sees only the
   * train side; the final reported numbers are on the held-out test
   * side, which fixes the selection bias in "best gmean after picking
   * the best". Split is deterministic by case hash, so the same case
   * always lands on the same side across reruns.
   */
  testFraction?: number;
  /** Optional llm-judge — replaces the heuristic content score for top-N variants each gen. */
  judge?: JudgeOpts & { topN?: number };
}

export async function evolvePrompt(opts: EvolveOpts): Promise<EvolutionResult> {
  const log = opts.onLog ?? ((t: string) => process.stdout.write(t + "\n"));
  const generations = opts.generations ?? 10;
  const populationCap = opts.populationCap ?? 8;
  const plateauGenerations = opts.plateauGenerations ?? 3;
  const mutateModel = opts.mutateModel ?? opts.evalModel;
  const canonGmean = opts.canonGmean ?? 0;
  const target = opts.target ?? "claude-overnight";
  const runId = opts.runId ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // ── 0. Initialise persistence ──
  initRun({
    runId,
    promptPath: opts.promptPath,
    target,
    evalModel: opts.evalModel,
    mutateModel,
    generations,
    populationCap,
    startedAt: new Date().toISOString(),
    status: "running",
    caseNames: opts.cases.map((c) => c.name),
  });
  log(`Run directory: ~/.claude-overnight/prompt-evolution/${runId}/`);

  // ── 0.5 Deterministic train/test split ──
  // Hold out a fraction of cases for the final validation eval so the
  // reported "winner" isn't chosen on the same data we measure it with.
  const { trainCases, testCases } = splitCases(opts.cases, opts.testFraction ?? 0);
  if (testCases.length > 0) {
    log(`Train/test split: ${trainCases.length} train / ${testCases.length} held-out test`);
  }

  // ── 1. Seed population from existing variants or seed text ──
  let population = opts.seedText
    ? [{ id: "default", promptPath: opts.promptPath, generation: 0, text: opts.seedText }]
    : seedPopulation(opts.promptPath);
  log(`Seeded ${population.length} variants from ${opts.promptPath}`);

  const learningLog: LearningEntry[] = [];
  let bestOverall: VariantRow | null = null;
  const generationMatrices: VariantRow[][] = [];
  let generationsWithoutImprovement = 0;

  for (let gen = 0; gen < generations; gen++) {
    log(`\n=== Generation ${gen + 1}/${generations} | Population: ${population.length} ===`);

    // ── 2. Evaluate ──
    const evalOpts: EvalOpts = {
      model: opts.evalModel,
      models: opts.evalModels,
      baseUrl: opts.baseUrl,
      authToken: opts.authToken,
      concurrency: opts.concurrency ?? 8,
      repetitions: opts.repetitions,
      judge: opts.judge,
      batch: opts.batch,
      batchBaseUrl: opts.batchBaseUrl,
      batchAuthToken: opts.batchAuthToken,
      batchModel: opts.batchModel,
      adaptiveReps: opts.adaptiveReps,
      runId,
      generation: gen,
      onProgress: (done, total, caseName, variantId) => {
        log(`  [${done}/${total}] ${variantId.slice(0, 16)} → ${caseName}`);
      },
      onBatchProgress: (msg) => log(`  [batch] ${msg}`),
    };

    const matrix = await buildMatrix(population, trainCases, evalOpts);
    generationMatrices.push(matrix);
    snapshotPrompts(runId, matrix);
    appendMatrix(runId, gen, matrix);
    log(formatMatrix(matrix, trainCases.map((c: BenchmarkCase) => c.name)));

    // Track best
    const genBest = matrix.reduce((a, b) => (a.gmean > b.gmean ? a : b));
    if (!bestOverall || genBest.gmean > bestOverall.gmean + 0.001) {
      bestOverall = genBest;
      generationsWithoutImprovement = 0;
    } else {
      generationsWithoutImprovement++;
    }

    // ── 3. Curate ──
    const curateOpts: CurateOpts = {
      eliteCount: Math.max(2, Math.floor(populationCap * 0.4)),
      diversityCount: Math.max(1, Math.floor(populationCap * 0.3)),
      promoteThreshold: 0.02,
    };
    const decision = curate(matrix, canonGmean, curateOpts);
    log(`Curator: promoted=[${decision.promoted.join(", ")}] kept=[${decision.kept.join(", ")}] quarantined=[${decision.quarantined.join(", ")}]`);

    // ── 4. Build next population ──
    const keptRows = matrix.filter((r) => decision.kept.includes(r.variantId));
    let nextPop = keptRows.map((r) => ({
      id: r.variantId,
      promptPath: r.promptPath,
      generation: r.generation,
      text: r.text,
    }));

    // ── 5. Mutate to refill ──
    const targetSize = Math.min(populationCap, keptRows.length + 2);
    const newEntries: LearningEntry[] = [];
    // Early stopping check
    if (generationsWithoutImprovement >= plateauGenerations && gen >= 2) {
      log(`\n=== Early stop: no improvement for ${generationsWithoutImprovement} generations ===`);
      break;
    }

    if (nextPop.length < targetSize && gen < generations - 1) {
      const mutantsNeeded = targetSize - nextPop.length;
      log(`Generating ${mutantsNeeded} mutant(s)...`);

      // Pick parents: worst-performing kept variants (they have the most room to improve)
      const sorted = [...keptRows].sort((a, b) => a.gmean - b.gmean);
      const parents = sorted.slice(0, mutantsNeeded);

      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i];
        const failures = [...parent.results.values()]
          .filter((r) => r.notes.length > 0 || gmean(r.scores) < 0.7)
          .sort((a, b) => gmean(a.scores) - gmean(b.scores))
          .slice(0, 3)
          .map((r) => ({
            caseName: r.caseName,
            caseHash: r.caseHash,
            rawOutput: r.rawOutput,
            notes: r.notes,
            scores: r.scores,
          }));

        const siblings = keptRows
          .filter((r) => r.variantId !== parent.variantId)
          .map((r) => r.text);

        const req: MutationRequest = {
          currentText: parent.text,
          promptPath: opts.promptPath,
          failures,
          learningLog,
          siblingTexts: siblings,
        };

        try {
          const mutant = await mutate(req, {
            model: mutateModel,
            baseUrl: opts.baseUrl,
            authToken: opts.authToken,
          });
          mutant.generation = gen + 1;
          mutant.parentId = parent.variantId;

          nextPop.push({
            id: mutant.variantId,
            promptPath: opts.promptPath,
            generation: mutant.generation,
            text: mutant.text,
          });

          const entry: LearningEntry = {
            generation: gen,
            mutationSummary: mutant.mutationSummary,
            fitnessDelta: 0, // filled next gen
            status: "neutral",
          };
          learningLog.push(entry);
          newEntries.push(entry);

          log(`  Mutant ${mutant.variantId} ← ${parent.variantId}: ${mutant.mutationSummary}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  Mutant failed: ${msg.slice(0, 120)}`);
        }
      }
    }

    if (newEntries.length) appendLearning(runId, newEntries);
    population = nextPop;
  }

  // Final evaluation of surviving population (on train cases — these are
  // the numbers used for curator decisions and for the "last generation"
  // report row). The test-set eval is a separate pass after this.
  log(`\n=== Final evaluation (train) ===`);
  const finalMatrix = await buildMatrix(population, trainCases, {
    model: opts.evalModel,
    models: opts.evalModels,
    baseUrl: opts.baseUrl,
    authToken: opts.authToken,
    concurrency: opts.concurrency ?? 8,
    repetitions: opts.repetitions,
    judge: opts.judge,
    batch: opts.batch,
    adaptiveReps: opts.adaptiveReps,
    runId,
    generation: generations,
    onBatchProgress: (msg) => log(`  [batch] ${msg}`),
  });
  generationMatrices.push(finalMatrix);
  snapshotPrompts(runId, finalMatrix);
  appendMatrix(runId, generations, finalMatrix);
  log(formatMatrix(finalMatrix, trainCases.map((c: BenchmarkCase) => c.name)));

  // Held-out test evaluation — the honest, selection-bias-free number.
  // Only the post-curation survivors get evaluated here (no mutation,
  // no curator re-runs), and the report's executive summary leads with
  // these numbers when available.
  let testMatrix: VariantRow[] | undefined;
  if (testCases.length > 0) {
    log(`\n=== Held-out test evaluation (${testCases.length} cases) ===`);
    testMatrix = await buildMatrix(population, testCases, {
      model: opts.evalModel,
      models: opts.evalModels,
      baseUrl: opts.baseUrl,
      authToken: opts.authToken,
      concurrency: opts.concurrency ?? 8,
      repetitions: opts.repetitions,
      batch: opts.batch,
      batchBaseUrl: opts.batchBaseUrl,
      batchAuthToken: opts.batchAuthToken,
      batchModel: opts.batchModel,
      adaptiveReps: opts.adaptiveReps,
      runId,
      generation: generations + 1,
      onBatchProgress: (msg) => log(`  [batch-test] ${msg}`),
    });
    log(formatMatrix(testMatrix, testCases.map((c: BenchmarkCase) => c.name)));
  }

  const best = finalMatrix.reduce((a, b) => (a.gmean > b.gmean ? a : b));
  const historicalBest = bestOverall && bestOverall.gmean > best.gmean ? bestOverall : best;

  const result: EvolutionResult = {
    bestVariant: historicalBest,
    allRows: finalMatrix,
    learningLog,
    runId,
  };

  // Generate and save report
  const baselineText = generationMatrices[0]?.find((r) => r.variantId === "default")?.text;
  const report = generateReport({
    runId,
    promptPath: opts.promptPath,
    target,
    evalModel: opts.evalModel,
    evalModels: opts.evalModels,
    repetitions: opts.repetitions,
    generations,
    baselineText,
  }, result, generationMatrices, testMatrix);

  const { writeFileSync } = await import("node:fs");
  const { runDir } = await import("./persistence.js");
  const reportPath = `${runDir(runId)}/report.md`;
  writeFileSync(reportPath, report);
  result.reportPath = reportPath;

  finalizeRun(runId, result);
  log(`\nReport saved: ${reportPath}`);

  return result;
}

// ── Helpers ──

/**
 * Deterministic hash-based split — the same case always lands on the
 * same side across runs, so the cache-built case pool remains coherent
 * whatever the evolution history.
 */
function splitCases(all: BenchmarkCase[], testFraction: number): {
  trainCases: BenchmarkCase[];
  testCases: BenchmarkCase[];
} {
  if (testFraction <= 0 || testFraction >= 1 || all.length === 0) {
    return { trainCases: all, testCases: [] };
  }
  const sorted = [...all].sort((a, b) => a.hash.localeCompare(b.hash));
  const testCount = Math.max(1, Math.round(sorted.length * testFraction));
  return {
    testCases: sorted.slice(0, testCount),
    trainCases: sorted.slice(testCount),
  };
}

function seedPopulation(promptPath: string): Array<{ id: string; promptPath: string; generation: number; text: string }> {
  const variants: Array<{ id: string; promptPath: string; generation: number; text: string }> = [];

  // Always seed the default (no variant)
  try {
    variants.push({
      id: "default",
      promptPath,
      generation: 0,
      text: renderPrompt(promptPath, {}),
    });
  } catch { /* prompt may require variants */ }

  // Seed named variants if the prompt has <!-- @@@ --> markers
  const namedVariants = ["TIGHT", "STANDARD", "LARGE", "WRAP", "AMEND", "WAVE", "RUN", "FILE", "ALL", "POSTFAILED", "NOFILES"];
  for (const v of namedVariants) {
    try {
      const text = renderVariant(promptPath, v, {});
      variants.push({ id: v.toLowerCase(), promptPath, generation: 0, text });
    } catch { /* variant doesn't exist in this prompt */ }
  }

  return variants;
}

function gmean(scores: { parse: number; schema: number; content: number; costEfficiency: number; speed: number }): number {
  const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
  const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
  return Math.pow(product, 1 / vals.length);
}
