/**
 * Persistence layer for prompt-evolution runs.
 *
 * Each run gets its own directory under the store root:
 *   ~/.claude-overnight/prompt-evolution/<runId>/
 *     meta.json        — run configuration, timestamps
 *     matrix.jsonl     — one line per variant (full evaluation matrix)
 *     learning.jsonl   — mutation history with fitness deltas
 *     best.md          — human-readable report of the best variant
 *     prompts/         — snapshot of every prompt variant tested
 *
 * This makes every run fully inspectable after the fact and enables
 * longitudinal analysis ("did our planner prompts get better over time?").
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

import { homedir } from "node:os";
import type { VariantRow, LearningEntry, EvolutionResult } from "./types.js";
import { join } from "node:path";

const DEFAULT_ROOT = join(homedir(), ".claude-overnight", "prompt-evolution");

export interface RunMeta {
  runId: string;
  promptPath: string;
  target: string;
  evalModel: string;
  mutateModel: string;
  generations: number;
  populationCap: number;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed";
  caseNames: string[];
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function storeRoot(): string {
  return process.env.PROMPT_EVOLUTION_STORE ?? DEFAULT_ROOT;
}

export function runDir(runId: string): string {
  return join(storeRoot(), runId);
}

/** Initialise a new run directory and write meta.json. */
export function initRun(meta: RunMeta): string {
  const root = runDir(meta.runId);
  ensureDir(root);
  ensureDir(join(root, "prompts"));
  writeFileSync(join(root, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return root;
}

/** Append a generation's matrix to matrix.jsonl. */
export function appendMatrix(runId: string, generation: number, rows: VariantRow[]) {
  const path = join(runDir(runId), "matrix.jsonl");
  const lines = rows.map((r) =>
    JSON.stringify({
      generation,
      variantId: r.variantId,
      promptPath: r.promptPath,
      aggregate: r.aggregate,
      gmean: r.gmean,
      perCase: [...r.results.values()].map((c) => ({
        caseName: c.caseName,
        caseHash: c.caseHash,
        scores: c.scores,
        notes: c.notes,
        costUsd: c.costUsd,
        durationMs: c.durationMs,
      })),
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n", { flag: "a" });
}

/** Append learning entries. */
export function appendLearning(runId: string, entries: LearningEntry[]) {
  const path = join(runDir(runId), "learning.jsonl");
  const lines = entries.map((e) => JSON.stringify(e));
  writeFileSync(path, lines.join("\n") + "\n", { flag: "a" });
}

/** Snapshot every prompt variant text to prompts/<variantId>.md. */
export function snapshotPrompts(runId: string, rows: VariantRow[]) {
  const dir = join(runDir(runId), "prompts");
  ensureDir(dir);
  for (const r of rows) {
    const safeId = r.variantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(
      join(dir, `${safeId}.md`),
      `<!-- generation=${r.generation} gmean=${(r.gmean * 100).toFixed(1)}% -->\n\n${r.text}\n`,
    );
  }
}

/** Finalise the run: write best.md and update meta.json. */
export function finalizeRun(runId: string, result: EvolutionResult, metaPartial?: Partial<RunMeta>) {
  const root = runDir(runId);
  const metaPath = join(root, "meta.json");

  const existing = JSON.parse(readFileSync(metaPath, "utf-8")) as RunMeta;
  const merged: RunMeta = {
    ...existing,
    ...metaPartial,
    status: "done",
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(merged, null, 2) + "\n");

  const best = result.bestVariant;
  const report = `# Prompt Evolution Run — ${runId}

## Best Variant

| Metric | Value |
|--------|-------|
| variantId | \`${best.variantId}\` |
| generation | ${best.generation} |
| gmean | ${(best.gmean * 100).toFixed(1)}% |
| parse | ${(best.aggregate.parse * 100).toFixed(1)}% |
| schema | ${(best.aggregate.schema * 100).toFixed(1)}% |
| content | ${(best.aggregate.content * 100).toFixed(1)}% |
| costEfficiency | ${(best.aggregate.costEfficiency * 100).toFixed(1)}% |
| speed | ${(best.aggregate.speed * 100).toFixed(1)}% |

## Prompt Text

\`\`\`markdown
${best.text}
\`\`\`

## Learning Log

| Gen | Summary | Δ | Status |
|-----|---------|---|--------|
${result.learningLog.map((l) => `| ${l.generation} | ${l.mutationSummary} | ${(l.fitnessDelta * 100).toFixed(1)}% | ${l.status} |`).join("\n")}

## Directory Layout

- \`meta.json\` — run configuration
- \`matrix.jsonl\` — per-generation evaluation matrix
- \`learning.jsonl\` — mutation history
- \`prompts/\` — snapshot of every variant tested
`;

  writeFileSync(join(root, "best.md"), report);
}

/**
 * Persist batch submission state so a crashed or restarted run can resume
 * polling instead of resubmitting (which would duplicate the bill).
 *
 * Keyed by (generation, phase) so multi-generation runs and eval-vs-judge
 * submissions don't collide. Written append-only — the latest entry wins
 * on load.
 */
export interface BatchStateEntry {
  generation: number;
  phase: "eval" | "judge";
  batchId: string;
  provider: "anthropic" | "openai-compatible";
  submittedAt: string;
  /** If set, we've already collected results for this entry — ignore on resume. */
  finishedAt?: string;
}

export function saveBatchState(runId: string, entry: BatchStateEntry): void {
  const path = join(runDir(runId), "batch-jobs.jsonl");
  writeFileSync(path, JSON.stringify(entry) + "\n", { flag: "a" });
}

export function loadBatchState(runId: string, generation: number, phase: "eval" | "judge"): BatchStateEntry | null {
  const path = join(runDir(runId), "batch-jobs.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  let latest: BatchStateEntry | null = null;
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as BatchStateEntry;
      if (e.generation === generation && e.phase === phase) latest = e;
    } catch { /* skip malformed */ }
  }
  // Only return if not yet finished — otherwise caller would re-poll a consumed batch.
  return latest && !latest.finishedAt ? latest : null;
}

export function markBatchFinished(runId: string, batchId: string): void {
  const path = join(runDir(runId), "batch-jobs.jsonl");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const updated = lines.map((line) => {
    try {
      const e = JSON.parse(line) as BatchStateEntry;
      if (e.batchId === batchId && !e.finishedAt) {
        e.finishedAt = new Date().toISOString();
        return JSON.stringify(e);
      }
    } catch { /* skip */ }
    return line;
  });
  writeFileSync(path, updated.join("\n") + "\n");
}

/** List all runs, newest first. */
export function listRuns(): Array<{ runId: string; meta: RunMeta }> {
  const root = storeRoot();
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const runs = dirs
    .map((id) => {
      try {
        const meta = JSON.parse(readFileSync(join(root, id, "meta.json"), "utf-8")) as RunMeta;
        return { runId: id, meta };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ runId: string; meta: RunMeta }>;

  runs.sort((a, b) => (b.meta.startedAt ?? "").localeCompare(a.meta.startedAt ?? ""));
  return runs;
}

/** Read a full run for inspection. */
export function loadRun(runId: string) {
  const root = runDir(runId);
  const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf-8")) as RunMeta;
  const matrix: unknown[] = [];
  try {
    const ml = readFileSync(join(root, "matrix.jsonl"), "utf-8").trim().split("\n");
    for (const line of ml) if (line) matrix.push(JSON.parse(line));
  } catch { /* empty matrix */ }
  const learning: unknown[] = [];
  try {
    const ll = readFileSync(join(root, "learning.jsonl"), "utf-8").trim().split("\n");
    for (const line of ll) if (line) learning.push(JSON.parse(line));
  } catch { /* empty learning */ }
  let bestMd = "";
  try {
    bestMd = readFileSync(join(root, "best.md"), "utf-8");
  } catch { /* no best.md yet */ }
  return { meta, matrix, learning, bestMd };
}
