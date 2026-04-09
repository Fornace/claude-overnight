import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, symlinkSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import chalk from "chalk";
import type { Task, RunState, BranchRecord, AgentState, RunMemory, WaveSummary } from "./types.js";

// ── File I/O helpers ──

export function readMdDir(dir: string): string {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();
    return files.map(f => {
      const content = readFileSync(join(dir, f), "utf-8");
      return `### ${f}\n${content}`;
    }).join("\n\n");
  } catch { return ""; }
}

export function readRunMemory(runDir: string, previousRuns?: string): RunMemory {
  let goal = "", status = "";
  try { goal = readFileSync(join(runDir, "goal.md"), "utf-8"); } catch {}
  try { status = readFileSync(join(runDir, "status.md"), "utf-8"); } catch {}
  return {
    designs: readMdDir(join(runDir, "designs")),
    reflections: readMdDir(join(runDir, "reflections")),
    verifications: readMdDir(join(runDir, "verifications")),
    milestones: readMdDir(join(runDir, "milestones")),
    status, goal, previousRuns,
  };
}

export function writeStatus(baseDir: string, status: string): void {
  writeFileSync(join(baseDir, "status.md"), status, "utf-8");
}

export function writeGoalUpdate(baseDir: string, update: string): void {
  const goalPath = join(baseDir, "goal.md");
  let existing = "";
  try { existing = readFileSync(goalPath, "utf-8"); } catch {}
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const entry = `\n\n## Update — ${ts}\n${update}`;
  const full = existing + entry;
  const trimmed = full.length > 4000 ? full.slice(0, 1000) + "\n\n...\n\n" + full.slice(-3000) : full;
  writeFileSync(goalPath, trimmed, "utf-8");
}

// ── Run state persistence ──

export function saveRunState(runDir: string, state: RunState): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify(state, null, 2), "utf-8");
}

export function loadRunState(runDir: string): RunState | null {
  try { return JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8")); }
  catch { return null; }
}

export function findIncompleteRuns(rootDir: string, filterCwd: string): { dir: string; state: RunState }[] {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    const results: { dir: string; state: RunState }[] = [];
    for (const d of dirs) {
      const state = loadRunState(join(runsDir, d));
      if (state && state.phase !== "done" && state.cwd === filterCwd) {
        results.push({ dir: join(runsDir, d), state });
      }
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

// ── History display ──

export function formatTimeAgo(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function showRunHistory(allRuns: { dir: string; state: RunState }[], filterCwd: string): void {
  const runs = allRuns.filter(r => r.state.cwd === filterCwd);
  if (runs.length === 0) { console.log(chalk.dim("\n  No run history.\n")); return; }
  const w = Math.min((process.stdout.columns ?? 80) - 6, 50);
  console.log(chalk.dim(`\n  ── Run History ${"─".repeat(Math.max(0, w - 16))}\n`));
  let resumeIdx = 0;
  for (const run of runs) {
    const s = run.state;
    const done = s.phase === "done";
    const icon = done ? chalk.green("✓") : chalk.yellow("⚠");
    const date = s.startedAt?.slice(0, 16).replace("T", " ") || "unknown";
    const cost = s.accCost > 0 ? ` · $${s.accCost.toFixed(2)}` : "";
    const obj = s.objective?.slice(0, 50) || "";
    const num = done ? " " : chalk.cyan(String(++resumeIdx));
    const merged = s.branches.filter(b => b.status === "merged").length;
    console.log(`  ${icon} ${num} ${chalk.dim(date)} · ${s.phase} · ${s.accCompleted}/${s.budget}${cost}${merged ? ` · ${merged} merged` : ""}`);
    console.log(`      ${obj}${obj.length >= 50 ? "…" : ""}`);
    let status = "";
    try { status = readFileSync(join(run.dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 70); } catch {}
    if (status) console.log(chalk.dim(`      ${status}`));
    console.log("");
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
      let status = "";
      try { status = readFileSync(join(runsDir, d, "status.md"), "utf-8"); } catch {}
      let goal = "";
      try { goal = readFileSync(join(runsDir, d, "goal.md"), "utf-8"); } catch {}
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
  const dir = join(baseDir, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `wave-${waveNum}.json`), JSON.stringify({
    wave: waveNum,
    agents: agents.map(a => ({
      id: a.id, prompt: a.task.prompt, status: a.status, error: a.error,
      cost: a.costUsd, toolCalls: a.toolCalls, filesChanged: a.filesChanged,
      duration: a.finishedAt && a.startedAt ? a.finishedAt - a.startedAt : 0,
      branch: a.branch,
    })),
    totalCost,
  }, null, 2), "utf-8");
}

export function loadWaveHistory(runDir: string): WaveSummary[] {
  const dir = join(runDir, "sessions");
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith("wave-") && f.endsWith(".json"))
      .sort((a, b) => {
        const numA = parseInt(a.replace("wave-", "").replace(".json", ""));
        const numB = parseInt(b.replace("wave-", "").replace(".json", ""));
        return numA - numB;
      })
      .map(f => {
        const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        return {
          wave: data.wave,
          tasks: (data.agents || []).map((a: any) => ({
            prompt: a.prompt, status: a.status, filesChanged: a.filesChanged, error: a.error,
          })),
        } as WaveSummary;
      });
  } catch { return []; }
}

// ── Branch management ──

export function recordBranches(
  agents: { branch?: string; task: { prompt: string }; status: string; filesChanged?: number; costUsd?: number }[],
  mergeResults: { branch: string; ok: boolean }[],
  branches: BranchRecord[],
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
    if (br) br.status = mr.ok ? "merged" : "merge-failed";
  }
}

export function autoMergeBranches(cwd: string, branches: BranchRecord[], onLog: (msg: string) => void): void {
  const unmerged = branches.filter(b => b.status === "unmerged" && b.filesChanged > 0);
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
        br.status = "merge-failed";
        onLog(`  ✗ ${br.branch} (conflict — preserved for manual merge)`);
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
  writeFileSync(join(milestoneDir, `wave-${waveNum}.md`), `# Milestone — Wave ${waveNum} (${ts})\n\n${content}`, "utf-8");
}
