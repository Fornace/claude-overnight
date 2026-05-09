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

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";

import { homedir } from "node:os";
import type { VariantRow, LearningEntry, EvolutionResult } from "./types.js";
import { join } from "node:path";
import { readFileOrEmpty, readJsonOrNull, writeJson } from "../core/fs-helpers.js";

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

function storeRoot(): string {
  return process.env.PROMPT_EVOLUTION_STORE ?? DEFAULT_ROOT;
}

export function runDir(runId: string): string {
  return join(storeRoot(), runId);
}

/** Initialise a new run directory and write meta.json. */
export function initRun(meta: RunMeta): string {
  const root = runDir(meta.runId);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeJson(join(root, "meta.json"), meta);
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
  mkdirSync(dir, { recursive: true });
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

  const existing = readJsonOrNull<RunMeta>(metaPath);
  if (!existing) throw new Error(`finalizeRun: missing or unreadable meta.json at ${metaPath}`);
  const merged: RunMeta = {
    ...existing,
    ...metaPartial,
    status: "done",
    finishedAt: new Date().toISOString(),
  };
  writeJson(metaPath, merged);

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


/** List all runs, newest first. */
export function listRuns(): Array<{ runId: string; meta: RunMeta }> {
  const root = storeRoot();
  if (!existsSync(root)) return [];
  const runs: Array<{ runId: string; meta: RunMeta }> = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const meta = readJsonOrNull<RunMeta>(join(root, d.name, "meta.json"));
    if (meta) runs.push({ runId: d.name, meta });
  }
  runs.sort((a, b) => (b.meta.startedAt ?? "").localeCompare(a.meta.startedAt ?? ""));
  return runs;
}

/** Parse a JSONL file (line-per-JSON) into an array; missing or empty → []. */
function readJsonLines(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileOrEmpty(path).trim().split("\n")) {
    if (line) try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

/** Read a full run for inspection. */
export function loadRun(runId: string) {
  const root = runDir(runId);
  const meta = readJsonOrNull<RunMeta>(join(root, "meta.json"));
  if (!meta) throw new Error(`loadRun: missing or unreadable meta.json at ${root}`);
  return {
    meta,
    matrix: readJsonLines(join(root, "matrix.jsonl")),
    learning: readJsonLines(join(root, "learning.jsonl")),
    bestMd: readFileOrEmpty(join(root, "best.md")),
  };
}
