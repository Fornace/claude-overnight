import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, symlinkSync, unlinkSync, renameSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import chalk from "chalk";
import type { Task, RunState, BranchRecord, AgentState, RunMemory, WaveSummary } from "../core/types.js";
import { forceMergeOverlay } from "../swarm/merge.js";
import { FALLBACK_MODEL } from "../core/models.js";
import { selectKey } from "../cli/cli.js";
import { readFileOrEmpty, readMdEntries, readJsonOrNull, writeJson } from "../core/fs-helpers.js";
import { terminalWidth } from "../ui/primitives.js";

// ── File I/O helpers ──

/** Concatenate every `.md` in `dir` as `### name\n<body>` blocks. Empty if missing. */
export function readMdDir(dir: string): string {
  return readMdEntries(dir).map(({ name, body }) => `### ${name}\n${body}`).join("\n\n");
}

function hasMdFiles(dir: string): boolean {
  try { return readdirSync(dir).some(f => f.endsWith(".md")); }
  catch { return false; }
}

export function readRunMemory(runDir: string, previousRuns?: string): RunMemory {
  return {
    designs: readMdDir(join(runDir, "designs")),
    reflections: readMdDir(join(runDir, "reflections")),
    verifications: readMdDir(join(runDir, "verifications")),
    milestones: readMdDir(join(runDir, "milestones")),
    status: readFileOrEmpty(join(runDir, "status.md")),
    goal: readFileOrEmpty(join(runDir, "goal.md")),
    previousRuns,
    userGuidance: readSteerInbox(runDir),
  };
}

// ── Steer inbox (user directives queued for the next steering call) ──

/** Read pending .md files in steer-inbox/ (top-level only, not processed/). */
export function readSteerInbox(runDir: string): string {
  return readMdEntries(join(runDir, "steer-inbox"))
    .map(({ body }) => body.trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** Count pending steer files without reading them. */
export function countSteerInbox(runDir: string): number {
  try { return readdirSync(join(runDir, "steer-inbox")).filter(f => f.endsWith(".md")).length; }
  catch { return 0; }
}

/** Append a user directive to the inbox as its own timestamped file. Returns the file path. */
export function writeSteerInbox(runDir: string, text: string): string {
  const dir = join(runDir, "steer-inbox");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  const path = join(dir, `${ts}-${rand}.md`);
  writeFileSync(path, text.trim() + "\n", "utf-8");
  return path;
}

/** Move all pending .md files from steer-inbox/ into steer-inbox/processed/wave-N/. Returns moved count. */
export function consumeSteerInbox(runDir: string, waveNum: number): number {
  const dir = join(runDir, "steer-inbox");
  let moved = 0;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    if (files.length === 0) return 0;
    const processedDir = join(dir, "processed", `wave-${waveNum}`);
    mkdirSync(processedDir, { recursive: true });
    for (const f of files) {
      try { renameSync(join(dir, f), join(processedDir, f)); moved++; } catch {}
    }
  } catch {}
  return moved;
}

export function writeStatus(baseDir: string, status: string): void {
  writeFileSync(join(baseDir, "status.md"), status, "utf-8");
}

export function writeGoalUpdate(baseDir: string, update: string): void {
  const goalPath = join(baseDir, "goal.md");
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const full = readFileOrEmpty(goalPath) + `\n\n## Update  -- ${ts}\n${update}`;
  const trimmed = full.length > 4000 ? full.slice(0, 1000) + "\n\n...\n\n" + full.slice(-3000) : full;
  writeFileSync(goalPath, trimmed, "utf-8");
}

// ── Durable run log (claude-overnight.log.md, committed) ──
// Tiny human-readable record per run so the objective survives even after
// .claude-overnight/ is cleaned up. Append-only friendly: each run's block
// is keyed by runId (the run dir basename) so concurrent runs on different
// machines don't collide.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface OvernightLogStart {
  objective: string;
  model: string;
  budget: number;
  flex: boolean;
  usageCap?: number;
  branch?: string;
}

export interface OvernightLogEnd {
  cost: number;
  completed: number;
  failed: number;
  waves: number;
  phase: string;
  elapsedSec: number;
}

export function appendOvernightLogStart(cwd: string, runId: string, meta: OvernightLogStart): void {
  const path = join(cwd, "claude-overnight.log.md");
  const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const capStr = meta.usageCap != null ? ` · **Cap:** ${meta.usageCap}%` : "";
  const branchLine = meta.branch ? `\n- **Branch:** ${meta.branch}` : "";
  const block = [
    `## ${runId}`,
    `- **Objective:** ${meta.objective || "(none)"}`,
    `- **Started:** ${startedAt}`,
    `- **Model:** ${meta.model} · **Budget:** ${meta.budget} · **Flex:** ${meta.flex ? "yes" : "no"}${capStr}${branchLine}`,
    `- **Status:** running`,
    "",
    "",
  ].join("\n");
  const existing = readFileOrEmpty(path);
  const header = existing ? "" : "# claude-overnight  -- run history\n\n";
  writeFileSync(path, header + existing + block, "utf-8");
}

export function updateOvernightLogEnd(cwd: string, runId: string, meta: OvernightLogEnd): void {
  const path = join(cwd, "claude-overnight.log.md");
  if (!existsSync(path)) return;
  const existing = readFileOrEmpty(path);
  const finishedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const sec = meta.elapsedSec;
  const elapsed = sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  const outcome = meta.phase === "done" ? "✓ done" : meta.phase === "capped" ? "⊘ capped" : "⊘ stopped";
  const endLines = [
    `- **Finished:** ${finishedAt} (${elapsed})`,
    `- **Cost:** $${meta.cost.toFixed(2)}`,
    `- **Tasks:** ${meta.completed} done${meta.failed > 0 ? ` / ${meta.failed} failed` : ""} · **Waves:** ${meta.waves}`,
    `- **Status:** ${outcome}`,
  ].join("\n");
  const re = new RegExp(`(## ${escapeRegExp(runId)}\\n(?:(?!\\n## )[\\s\\S])*?)- \\*\\*Status:\\*\\* running`);
  if (re.test(existing)) {
    writeFileSync(path, existing.replace(re, `$1${endLines}`), "utf-8");
  } else {
    const header = existing ? "" : "# claude-overnight  -- run history\n\n";
    const block = `## ${runId}\n${endLines}\n\n`;
    writeFileSync(path, header + existing + block, "utf-8");
  }
}

// ── Run state persistence ──

/**
 * Required fields on every persisted RunState. The type already marks these as
 * non-optional, but callers that build state dynamically (or upcast through
 * `any`) can still slip a truncated snapshot past the compiler. A truncated
 * snapshot is silently excluded by `findIncompleteRuns` (cwd-equality filter),
 * so the run becomes unresumable without any visible error. Guard at the write
 * boundary so the bug surfaces where it's introduced, not weeks later.
 */
const REQUIRED_RUN_STATE_FIELDS = ["cwd", "id", "phase", "startedAt"] as const;

export function saveRunState(runDir: string, state: RunState): void {
  const missing = REQUIRED_RUN_STATE_FIELDS.filter(k => !(state as unknown as Record<string, unknown>)[k]);
  if (missing.length) {
    throw new Error(`saveRunState: refusing to persist truncated state, missing fields: ${missing.join(", ")}`);
  }
  writeJson(join(runDir, "run.json"), state);
}

export function loadRunState(runDir: string): RunState | null {
  const state = readJsonOrNull<RunState>(join(runDir, "run.json"));
  if (!state) return null;
  if (!Array.isArray(state.branches)) state.branches = [];
  if (!Array.isArray((state as unknown as { currentTasks: unknown }).currentTasks)) state.currentTasks = [];
  return state;
}

export function findIncompleteRuns(rootDir: string, filterCwd: string): { dir: string; state: RunState }[] {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    const results: { dir: string; state: RunState }[] = [];
    for (const d of dirs) {
      const runDir = join(runsDir, d);
      const state = loadRunState(runDir);
      if (!state || state.phase === "done" || state.cwd !== filterCwd) continue;
      // Filter empty planning shells: no tasks.json, no designs/, no spent
      // cost or completed sessions — nothing to resume.
      if (state.phase === "planning"
          && !existsSync(join(runDir, "tasks.json"))
          && !hasMdFiles(join(runDir, "designs"))
          && (state.accCost ?? 0) === 0
          && (state.accCompleted ?? 0) === 0
          && (state.accFailed ?? 0) === 0) {
        continue;
      }
      results.push({ dir: runDir, state });
    }
    return results;
  } catch { return []; }
}

export function findOrphanedDesigns(rootDir: string): string | null {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    for (const d of dirs) {
      const runDir = join(runsDir, d);
      if (existsSync(join(runDir, "run.json"))) continue;
      const designs = readMdDir(join(runDir, "designs"));
      if (designs) return runDir;
    }
  } catch {}
  return null;
}

/**
 * Backfill run.json for pre-1.11.7 orphaned plans: runs where orchestrate's
 * agent wrote tasks.json via its Write tool but the process died before
 * executeRun ever got to saveRunState. Without this, those runs are invisible
 * to findIncompleteRuns forever.
 *
 * Idempotent: runs with an existing run.json are skipped. Synthesizes a
 * minimal "planning" state from what can be read off disk  -- dir name for
 * timestamp, task count for budget, sane defaults for everything else.
 * The cwd field is set to filterCwd so findIncompleteRuns picks it up on the
 * current project (which is safe  -- rootDir is already scoped to `cwd`).
 */
export function backfillOrphanedPlans(rootDir: string, filterCwd: string): number {
  const runsDir = join(rootDir, "runs");
  let count = 0;
  try {
    const dirs = readdirSync(runsDir);
    for (const d of dirs) {
      const runDir = join(runsDir, d);
      if (existsSync(join(runDir, "run.json"))) continue;
      const tasksFile = join(runDir, "tasks.json");
      const parsed = readJsonOrNull<{ tasks?: unknown[] }>(tasksFile);
      if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) continue;
      const taskCount = parsed.tasks.length;

      // Dir name format: 2026-04-12T13-03-57 (UTC). Convert to ISO.
      const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
      const startedAt = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : new Date(0).toISOString();

      try {
        saveRunState(runDir, {
          id: d,
          objective: `(recovered pre-1.11.7 plan · ${taskCount} tasks)`,
          budget: taskCount, remaining: taskCount,
          workerModel: FALLBACK_MODEL, plannerModel: FALLBACK_MODEL,
          concurrency: 5,
          flex: false, useWorktrees: true, mergeStrategy: "yolo",
          allowExtraUsage: false,
          waveNum: 0, currentTasks: [],
          accCost: 0, accCompleted: 0, accFailed: 0,
          accIn: 0, accOut: 0, accTools: 0,
          branches: [],
          phase: "planning",
          startedAt,
          cwd: filterCwd,
          repoFingerprint: "000000000000",
        });
        count++;
      } catch {}
    }
  } catch {}
  return count;
}

// ── History display ──

export function formatTimeAgo(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (!isFinite(ms)) return "unknown";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function showRunHistory(allRuns: { dir: string; state: RunState }[], filterCwd: string, resumable: { dir: string }[] = []): Promise<void> {
  const resumableDirs = new Set(resumable.map(r => r.dir));
  const runs = allRuns.filter(r => r.state.cwd === filterCwd && !resumableDirs.has(r.dir));
  if (runs.length === 0) { console.log(chalk.dim("\n  No run history.\n")); return; }
  const PAGE = 5;
  const pages = Math.ceil(runs.length / PAGE);
  let page = 0;
  while (true) {
    const w = Math.min(terminalWidth() - 6, 50);
    const pageLabel = pages > 1 ? ` (${page + 1}/${pages})` : "";
    console.log(chalk.dim(`\n  ── Run History${pageLabel} ${"─".repeat(Math.max(0, w - 16 - pageLabel.length))}\n`));
    for (const run of runs.slice(page * PAGE, (page + 1) * PAGE)) {
      const s = run.state;
      const date = s.startedAt?.slice(0, 16).replace("T", " ") || "unknown";
      const cost = s.accCost > 0 ? ` · $${s.accCost.toFixed(2)}` : "";
      const obj = s.objective?.slice(0, 50) || "";
      const merged = s.branches.filter(b => b.status === "merged").length;
      const icon = s.phase === "done" ? chalk.green("✓") : chalk.dim("·");
      console.log(`  ${icon} ${chalk.dim(date)} · ${s.phase} · ${s.accCompleted}/${s.budget}${cost}${merged ? ` · ${merged} merged` : ""}`);
      console.log(`      ${obj}${obj.length >= 50 ? "…" : ""}`);
      const status = readFileOrEmpty(join(run.dir, "status.md")).trim().split("\n")[0].slice(0, 70);
      if (status) console.log(chalk.dim(`      ${status}`));
      console.log("");
    }
    if (pages === 1) break;
    const opts: { key: string; desc: string }[] = [];
    if (page < pages - 1) opts.push({ key: "n", desc: "ext" });
    if (page > 0) opts.push({ key: "p", desc: "rev" });
    opts.push({ key: "b", desc: "ack" });
    const action = await selectKey("", opts);
    if (action === "n") { page++; continue; }
    if (action === "p") { page--; continue; }
    break;
  }
}

export function readPreviousRunKnowledge(rootDir: string): string {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    const summaries: string[] = [];
    for (const d of dirs) {
      if (summaries.length >= 5) break;
      const state = loadRunState(join(runsDir, d));
      if (!state || state.phase !== "done") continue;
      const status = readFileOrEmpty(join(runsDir, d, "status.md"));
      const goal = readFileOrEmpty(join(runsDir, d, "goal.md"));
      const date = d.replace("T", " ").slice(0, 19);
      const cost = state.accCost > 0 ? ` · $${state.accCost.toFixed(2)}` : "";
      summaries.push(`### Run ${date} (${state.accCompleted} tasks${cost})\n${status || "(no status recorded)"}\n${goal ? `Goal: ${goal.slice(0, 500)}` : ""}`);
    }
    return summaries.join("\n\n");
  } catch { return ""; }
}

// ── Run directory management ──

export function createRunDir(rootDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(rootDir, "runs", ts);
  mkdirSync(join(runDir, "designs"), { recursive: true });
  mkdirSync(join(runDir, "reflections"), { recursive: true });
  mkdirSync(join(runDir, "verifications"), { recursive: true });
  mkdirSync(join(runDir, "milestones"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  updateLatestSymlink(rootDir, runDir);
  return runDir;
}

export function updateLatestSymlink(rootDir: string, runDir: string): void {
  const link = join(rootDir, "latest");
  try { unlinkSync(link); } catch {}
  try { symlinkSync(runDir, link); } catch {}
}

// ── Wave session persistence ──

export function saveWaveSession(
  baseDir: string, waveNum: number,
  agents: AgentState[], totalCost: number,
): void {
  writeJson(join(baseDir, "sessions", `wave-${waveNum}.json`), {
    wave: waveNum,
    agents: agents.map(a => ({
      id: a.id, prompt: a.task.prompt, status: a.status, error: a.error,
      cost: a.costUsd, toolCalls: a.toolCalls, filesChanged: a.filesChanged,
      duration: a.finishedAt && a.startedAt ? a.finishedAt - a.startedAt : 0,
      branch: a.branch,
    })),
    totalCost,
  });
}

export function loadWaveHistory(runDir: string): WaveSummary[] {
  const dir = join(runDir, "sessions");
  let names: string[];
  try { names = readdirSync(dir).filter(f => f.startsWith("wave-") && f.endsWith(".json")); }
  catch { return []; }
  names.sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  const out: WaveSummary[] = [];
  for (const f of names) {
    const data = readJsonOrNull<{ wave: number; agents?: { prompt: string; status: string; filesChanged: number; error?: string }[] }>(join(dir, f));
    if (!data) continue;
    out.push({
      wave: data.wave,
      tasks: (data.agents ?? []).map(a => ({
        prompt: a.prompt, status: a.status as WaveSummary["tasks"][number]["status"], filesChanged: a.filesChanged, error: a.error,
      })),
    });
  }
  return out;
}

// ── Branch management ──

export function recordBranches(
  agents: { branch?: string; task: { prompt: string }; status: string; filesChanged?: number; costUsd?: number }[],
  mergeResults: { branch: string; ok: boolean }[],
  branches: BranchRecord[],
  currentWave?: number,
): void {
  for (const a of agents) {
    if (a.branch) {
      branches.push({
        branch: a.branch,
        taskPrompt: a.task.prompt.slice(0, 200),
        status: a.status === "done" ? "unmerged" : "failed",
        filesChanged: a.filesChanged ?? 0,
        costUsd: a.costUsd ?? 0,
      });
    }
  }
  for (const mr of mergeResults) {
    const br = branches.find(b => b.branch === mr.branch);
    if (br) {
      br.status = mr.ok ? "merged" : "merge-failed";
      if (!mr.ok && !br.firstFailedWave && currentWave !== undefined) {
        br.firstFailedWave = currentWave;
      }
    }
  }
}

export function autoMergeBranches(cwd: string, branches: BranchRecord[], onLog: (msg: string) => void): void {
  // Do NOT gate on filesChanged  -- pre-1.11.10 runs can record filesChanged=0
  // for branches that actually contain real commits (agent self-committed).
  // Feed every unmerged branch to git; it will no-op harmlessly if truly empty.
  const unmerged = branches.filter(b => b.status === "unmerged");
  if (unmerged.length === 0) return;
  onLog(`Merging ${unmerged.length} unmerged branches...`);
  for (const br of unmerged) {
    try {
      execSync(`git merge --no-edit "${br.branch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
      br.status = "merged";
      onLog(`  ✓ ${br.branch} (${br.filesChanged} files)`);
    } catch {
      try {
        try { execSync("git merge --abort", { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
        execSync(`git merge --no-edit -X theirs "${br.branch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
        br.status = "merged";
        onLog(`  ✓ ${br.branch} (auto-resolved)`);
      } catch {
        try { execSync("git merge --abort", { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
        if (forceMergeOverlay(br.branch, cwd)) {
          br.status = "merged";
          onLog(`  ✓ ${br.branch} (force-merged)`);
        } else {
          br.status = "merge-failed";
          onLog(`  ✗ ${br.branch} (conflict  -- preserved for manual merge)`);
        }
      }
    }
  }
}

export function archiveMilestone(baseDir: string, waveNum: number): void {
  const statusPath = join(baseDir, "status.md");
  if (!existsSync(statusPath)) return;
  const content = readFileSync(statusPath, "utf-8");
  if (!content.trim()) return;
  const milestoneDir = join(baseDir, "milestones");
  mkdirSync(milestoneDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  writeFileSync(join(milestoneDir, `wave-${waveNum}.md`), `# Milestone  -- Wave ${waveNum} (${ts})\n\n${content}`, "utf-8");
}
