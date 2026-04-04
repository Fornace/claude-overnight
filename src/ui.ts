import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { AgentState } from "./types.js";

export function renderFrame(swarm: Swarm): string {
  const w = Math.max(process.stdout.columns || 80, 60);
  const out: string[] = [];

  // ── Header ──
  const barW = Math.min(30, w - 50);
  const pct = swarm.total > 0 ? swarm.completed / swarm.total : 0;
  const filled = Math.round(pct * barW);
  const bar =
    chalk.green("\u2588".repeat(filled)) +
    chalk.gray("\u2591".repeat(barW - filled));

  const phaseLabel =
    swarm.phase === "planning"
      ? chalk.magenta(" PLANNING")
      : swarm.phase === "merging"
        ? chalk.yellow(" MERGING")
        : "";

  out.push("");
  out.push(
    `  ${chalk.bold.white("CLAUDE SWARM")}${phaseLabel}  ${bar}  ` +
      `${swarm.completed}/${swarm.total}  ` +
      chalk.cyan(`${swarm.active} active`) +
      "  " +
      chalk.gray(`${swarm.pending} queued`) +
      "  " +
      chalk.gray(`\u23F1 ${fmtDur(Date.now() - swarm.startedAt)}`),
  );
  // Stats line
  const tokIn = fmtTokens(swarm.totalInputTokens);
  const tokOut = fmtTokens(swarm.totalOutputTokens);
  const cost =
    swarm.totalCostUsd > 0
      ? chalk.yellow(`$${swarm.totalCostUsd.toFixed(3)}`)
      : "";
  const rlPct = swarm.rateLimitUtilization;
  const rlBar =
    rlPct > 0
      ? "  " +
        (rlPct > 0.8
          ? chalk.red(`RL ${Math.round(rlPct * 100)}%`)
          : rlPct > 0.5
            ? chalk.yellow(`RL ${Math.round(rlPct * 100)}%`)
            : chalk.green(`RL ${Math.round(rlPct * 100)}%`))
      : "";
  out.push(
    chalk.gray(`  \u2191 ${tokIn} in  \u2193 ${tokOut} out`) +
      (cost ? `  ${cost}` : "") +
      rlBar,
  );
  out.push("");

  // ── Agent table ──
  const running = swarm.agents.filter((a) => a.status === "running");
  const finished = swarm.agents.filter((a) => a.status !== "running");
  const showFinished = finished.slice(
    -Math.max(2, 12 - running.length),
  );
  const show = [...running, ...showFinished];

  if (show.length > 0) {
    out.push(
      chalk.gray(
        "  #   Status   Task" +
          " ".repeat(Math.max(1, w - 56)) +
          "Action",
      ),
    );
    out.push(chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, 100))));
    for (const a of show) {
      out.push(fmtRow(a, w));
    }
    if (swarm.pending > 0) {
      out.push(chalk.gray(`  ... + ${swarm.pending} queued`));
    }
  }

  // ── Merge results ──
  if (swarm.mergeResults.length > 0) {
    out.push("");
    out.push(chalk.gray("  \u2500\u2500\u2500 Merges " + "\u2500".repeat(Math.min(w - 16, 90))));
    for (const mr of swarm.mergeResults) {
      const icon = mr.ok ? chalk.green("\u2713") : chalk.red("\u2717");
      const info = mr.ok
        ? chalk.dim(`${mr.filesChanged} file(s)`)
        : chalk.red(truncate(mr.error || "conflict", 40));
      out.push(`  ${icon} ${mr.branch}  ${info}`);
    }
  }

  // ── Event log ──
  out.push("");
  out.push(
    chalk.gray(
      "  \u2500\u2500\u2500 Events " +
        "\u2500".repeat(Math.min(w - 16, 90)),
    ),
  );
  const logN = Math.min(10, swarm.logs.length);
  for (const entry of swarm.logs.slice(-logN)) {
    const t = new Date(entry.time).toLocaleTimeString("en", {
      hour12: false,
    });
    const tag =
      entry.agentId < 0
        ? chalk.magenta("[sys]")
        : chalk.cyan(`[${entry.agentId}]`);
    out.push(
      chalk.gray(`  ${t} `) + tag + ` ${truncate(entry.text, w - 22)}`,
    );
  }

  out.push("");
  return out.join("\n");
}

function fmtRow(a: AgentState, w: number): string {
  const id = String(a.id).padStart(3);

  const icon =
    a.status === "running"
      ? chalk.blue("\u27F3 run ")
      : a.status === "done"
        ? chalk.green("\u2713 done")
        : chalk.red("\u2717 err ");

  const taskW = Math.max(20, Math.min(36, w - 50));
  const task = truncate(a.task.prompt, taskW).padEnd(taskW);

  let action: string;
  if (a.currentTool) {
    action = chalk.yellow(a.currentTool);
  } else if (a.status === "running") {
    action = chalk.dim(truncate(a.lastText || "...", 24));
  } else if (a.status === "done") {
    const dur = fmtDur(
      (a.finishedAt || Date.now()) - (a.startedAt || Date.now()),
    );
    const cost = a.costUsd != null ? ` $${a.costUsd.toFixed(3)}` : "";
    const files =
      a.filesChanged != null && a.filesChanged > 0
        ? chalk.dim(` ${a.filesChanged}f`)
        : "";
    action = chalk.dim(`${dur}${cost}${files}`);
  } else {
    action = chalk.red(truncate(a.error || "error", 24));
  }

  return `  ${id}  ${icon}  ${task}  ${action}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function startRenderLoop(swarm: Swarm): () => void {
  process.stdout.write("\x1B[?25l\x1B[2J\x1B[H");

  const interval = setInterval(() => {
    process.stdout.write("\x1B[H\x1B[J");
    process.stdout.write(renderFrame(swarm));
  }, 250);

  return () => {
    clearInterval(interval);
    process.stdout.write("\x1B[H\x1B[J");
    process.stdout.write(renderFrame(swarm));
    process.stdout.write("\x1B[?25h");
  };
}
