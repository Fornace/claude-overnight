import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { AgentState } from "./types.js";

const SPINNER = ["|", "/", "-", "\\"] as const;
const WINDOW_SHORT_NAMES: Record<string, string> = {
  five_hour: "5h", seven_day: "7d", seven_day_opus: "7d op",
  seven_day_sonnet: "7d sn", overage: "extra",
};

function colorEvent(text: string): string {
  if (text === "Done" || text.startsWith("Merged ") || text.startsWith("Committed ")) return chalk.green(text);
  if (text.startsWith("Rate:") || text.startsWith("Rate limited") || text.startsWith("Soft throttle")) return chalk.magenta(text);
  if (/error|fail|conflict/i.test(text)) return chalk.red(text);
  if (!text.includes(" ") && text.length <= 40) return chalk.yellow(text);
  return text;
}

export function renderFrame(swarm: Swarm, showHotkeys = false): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
  const out: string[] = [];

  // ── Header ──
  const barW = Math.min(30, w - 50);
  const pct = swarm.total > 0 ? swarm.completed / swarm.total : 0;
  const filled = Math.round(pct * barW);
  const bar =
    chalk.green("\u2588".repeat(filled)) +
    chalk.gray("\u2591".repeat(barW - filled));

  const stoppingTag = swarm.aborted ? chalk.yellow(" STOPPING") : "";
  const phaseLabel =
    (swarm.phase === "planning"
      ? chalk.magenta(" PLANNING")
      : swarm.phase === "merging"
        ? chalk.yellow(" MERGING")
        : "") + stoppingTag;

  const modelTag = swarm.model ? chalk.dim(` [${swarm.model}]`) : "";

  out.push("");
  out.push(
    `  ${chalk.bold.white("CLAUDE OVERNIGHT")}${modelTag}${phaseLabel}  ${bar}  ` +
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
  out.push(
    chalk.gray(`  \u2191 ${tokIn} in  \u2193 ${tokOut} out`) +
      (cost ? `  ${cost}` : ""),
  );

  // ── Usage bar(s) — cycle through windows every 3s ──
  const windows = Array.from(swarm.rateLimitWindows.values());
  const rlPct = swarm.rateLimitUtilization;
  if (rlPct > 0 || swarm.rateLimitResetsAt || swarm.cappedOut || windows.length > 0) {
    const barW = Math.min(30, w - 40);
    const capFrac = swarm.usageCap;
    const capMark = capFrac != null && capFrac < 1 ? Math.round(capFrac * barW) : -1;

    // Show primary usage bar
    const renderBar = (pct: number, windowLabel?: string) => {
      const filled = Math.round(pct * barW);
      let barStr = "";
      for (let i = 0; i < barW; i++) {
        if (i === capMark) barStr += chalk.yellow("\u2502");
        else if (i < filled) barStr += pct > 0.9 ? chalk.red("\u2588") : pct > 0.75 ? chalk.yellow("\u2588") : chalk.blue("\u2588");
        else barStr += chalk.gray("\u2591");
      }
      let label = `${Math.round(pct * 100)}% used`;
      if (swarm.cappedOut) {
        if (swarm.isUsingOverage && !swarm.allowExtraUsage) {
          label = chalk.red("Extra usage blocked — stopping");
        } else {
          label = chalk.yellow(`Capped at ${capFrac != null ? Math.round(capFrac * 100) : 100}% — finishing active`);
        }
      } else if (swarm.rateLimitResetsAt && swarm.rateLimitResetsAt > Date.now()) {
        const waitSec = Math.ceil((swarm.rateLimitResetsAt - Date.now()) / 1000);
        const mm = Math.floor(waitSec / 60);
        const ss = waitSec % 60;
        label = chalk.red(`Waiting for reset ${mm > 0 ? `${mm}m ${ss}s` : `${ss}s`}`);
      }
      if (swarm.isUsingOverage && !swarm.cappedOut) {
        const budgetInfo = swarm.extraUsageBudget != null
          ? ` $${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget}`
          : "";
        label += chalk.red(` [EXTRA USAGE${budgetInfo}]`);
      }
      const prefix = windowLabel ? chalk.dim(windowLabel.padEnd(6)) : chalk.dim("Usage ");
      out.push(`  ${prefix}${barStr}  ${label}`);
    };

    if (windows.length > 1) {
      // Cycle through windows every 3 seconds
      const cycleIdx = Math.floor(Date.now() / 3000) % windows.length;
      const win = windows[cycleIdx];
      const shortName = WINDOW_SHORT_NAMES[win.type] ?? win.type.replace(/_/g, " ");
      renderBar(win.utilization, shortName);
      // Show dots indicator for which window we're viewing
      const dots = windows.map((_, i) => i === cycleIdx ? "●" : "○").join("");
      out[out.length - 1] += chalk.dim(`  ${dots}`);
    } else {
      renderBar(rlPct);
    }
  }

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
      chalk.gray(`  ${t} `) + tag + ` ${colorEvent(truncate(entry.text, w - 22))}`,
    );
  }

  if (showHotkeys) out.push(chalk.dim("  [b] budget  [t] threshold  [q] stop"));
  out.push("");
  return out.join("\n");
}

/** Mutable config that can be changed live during execution. */
export interface LiveConfig {
  remaining: number;
  usageCap: number | undefined;
  /** Set by hotkey handler when user changes a value. Cleared after main loop reads it. */
  dirty: boolean;
}

function fmtRow(a: AgentState, w: number): string {
  const id = String(a.id).padStart(3);

  const elapsed =
    a.status === "running" && a.startedAt
      ? " " + chalk.dim(fmtDur(Date.now() - a.startedAt))
      : "";
  const spin = SPINNER[Math.floor(Date.now() / 250) % SPINNER.length];
  const icon =
    a.status === "running"
      ? chalk.blue(`${spin} run`) + elapsed
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

export function startRenderLoop(swarm: Swarm, liveConfig?: LiveConfig): () => void {
  if (!process.stdout.isTTY) {
    return startPlainLog(swarm);
  }

  try {
    process.stdout.write("\x1B[?25l\x1B[2J\x1B[H");
  } catch {
    return () => {};
  }

  // Live hotkey input state
  let inputMode: "none" | "budget" | "threshold" = "none";
  let inputBuf = "";

  const hasHotkeys = !!liveConfig && !!process.stdin.isTTY;
  const render = () => {
    let frame = renderFrame(swarm, hasHotkeys);
    if (inputMode !== "none") {
      const label = inputMode === "budget" ? "New budget (remaining sessions)" : "New usage cap (0-100%)";
      frame += `\n  ${chalk.cyan(">")} ${label}: ${inputBuf}█`;
    }
    return frame;
  };

  const interval = setInterval(() => {
    try {
      process.stdout.write("\x1B[H\x1B[J");
      process.stdout.write(render());
    } catch {
      clearInterval(interval);
    }
  }, 250);

  // Keyboard listener for live controls
  let keyHandler: ((buf: Buffer) => void) | undefined;
  if (liveConfig && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode!(true);
      process.stdin.resume();
    } catch {}
    keyHandler = (buf: Buffer) => {
      const s = buf.toString();
      if (inputMode !== "none") {
        if (s === "\r" || s === "\n") {
          const val = parseFloat(inputBuf);
          if (inputMode === "budget" && !isNaN(val) && val > 0) {
            liveConfig.remaining = Math.round(val);
            liveConfig.dirty = true;
            swarm.log(-1, `Budget changed to ${liveConfig.remaining} remaining`);
          } else if (inputMode === "threshold" && !isNaN(val) && val >= 0 && val <= 100) {
            const frac = val / 100;
            liveConfig.usageCap = frac > 0 ? frac : undefined;
            liveConfig.dirty = true;
            swarm.usageCap = liveConfig.usageCap;
            swarm.log(-1, `Usage cap changed to ${val > 0 ? val + "%" : "unlimited"}`);
          }
          inputMode = "none";
          inputBuf = "";
        } else if (s === "\x1B" || s === "\x03") {
          inputMode = "none";
          inputBuf = "";
        } else if (s === "\x7F") {
          inputBuf = inputBuf.slice(0, -1);
        } else if (/^[0-9.]$/.test(s)) {
          inputBuf += s;
        }
        return;
      }
      if (s === "b" || s === "B") { inputMode = "budget"; inputBuf = ""; }
      else if (s === "t" || s === "T") { inputMode = "threshold"; inputBuf = ""; }
      else if (s === "q" || s === "Q" || s === "\x03") {
        if (swarm.aborted) process.exit(0); // second press = force quit
        swarm.abort();
      }
    };
    process.stdin.on("data", keyHandler);
  }

  return () => {
    clearInterval(interval);
    if (keyHandler) {
      process.stdin.removeListener("data", keyHandler);
      try {
        process.stdin.setRawMode!(false);
        process.stdin.pause();
      } catch {}
    }
    try {
      process.stdout.write("\x1B[H\x1B[J");
      process.stdout.write(renderFrame(swarm));
      process.stdout.write("\x1B[?25h");
    } catch {}
  };
}

export function renderSummary(swarm: Swarm): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
  const out: string[] = [];

  // Fixed column widths: #(3) + Status(6) + Duration(8) + Files(5) + Tools(5) + Cost(8)
  // gaps: 6×2 = 12, indent = 2 → task gets the rest
  const fixedW = 3 + 6 + 8 + 5 + 5 + 8 + 12 + 2;
  const taskW = Math.max(10, w - fixedW);

  const hdr =
    chalk.gray(
      "  " +
        "#".padStart(3) +
        "  " +
        "Status".padEnd(6) +
        "  " +
        "Task".padEnd(taskW) +
        "  " +
        "Duration".padStart(8) +
        "  " +
        "Files".padStart(5) +
        "  " +
        "Tools".padStart(5) +
        "  " +
        "Cost".padStart(8),
    );
  const sep = chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, fixedW + taskW)));

  out.push("");
  out.push(hdr);
  out.push(sep);

  const groups: AgentState[][] = [
    swarm.agents.filter(a => a.status === "running"),
    swarm.agents.filter(a => a.status === "done"),
    swarm.agents.filter(a => a.status === "error"),
  ].filter(g => g.length > 0);

  const thinSep = chalk.gray("  " + "\u254C".repeat(Math.min(w - 4, fixedW + taskW)));

  let totalDurMs = 0;
  let totalFiles = 0;
  let totalTools = 0;
  let totalCost = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) out.push(thinSep);
    for (const a of groups[gi]) {
      const id = String(a.id).padStart(3);
      const ok = a.status === "done";
      const status = ok
        ? chalk.green("\u2713 done")
        : a.status === "running"
          ? chalk.blue("~ run ")
          : chalk.red("\u2717 err ");
      const task = truncate(a.task.prompt, taskW).padEnd(taskW);

      const durMs =
        a.startedAt != null
          ? (a.finishedAt ?? Date.now()) - a.startedAt
          : 0;
      const dur = fmtDur(durMs).padStart(8);
      const files = String(a.filesChanged ?? 0).padStart(5);
      const tools = String(a.toolCalls).padStart(5);
      const cost =
        a.costUsd != null ? `$${a.costUsd.toFixed(3)}`.padStart(8) : "".padStart(8);

      totalDurMs += durMs;
      totalFiles += a.filesChanged ?? 0;
      totalTools += a.toolCalls;
      totalCost += a.costUsd ?? 0;

      const color = ok ? chalk.white : a.status === "running" ? chalk.blue : chalk.red;
      out.push(
        color(
          `  ${id}  ${status}  ${task}  ${dur}  ${files}  ${tools}  ${cost}`,
        ),
      );
    }
  }

  out.push(sep);

  // Totals row
  const label = `${swarm.agents.length} tasks`.padEnd(taskW);
  out.push(
    chalk.bold(
      `  ${"".padStart(3)}  ${"Total ".padEnd(6)}  ${label}  ${fmtDur(totalDurMs).padStart(8)}  ${String(totalFiles).padStart(5)}  ${String(totalTools).padStart(5)}  ${`$${totalCost.toFixed(3)}`.padStart(8)}`,
    ),
  );
  out.push("");

  return out.join("\n");
}

function startPlainLog(swarm: Swarm): () => void {
  let lastSeq = swarm.logSequence;
  let lastCompleted = -1;

  const write = (line: string) => {
    try { process.stdout.write(line + "\n"); } catch { clearInterval(interval); }
  };

  const interval = setInterval(() => {
    const currentSeq = swarm.logSequence;
    if (currentSeq > lastSeq) {
      // Read the most recent (currentSeq - lastSeq) entries from the tail of the log
      const newCount = currentSeq - lastSeq;
      const available = swarm.logs.length;
      const toShow = Math.min(newCount, available);
      for (const entry of swarm.logs.slice(available - toShow)) {
        const t = new Date(entry.time).toLocaleTimeString("en", { hour12: false });
        const tag = entry.agentId < 0 ? "[sys]" : `[${entry.agentId}]`;
        write(`${t} ${tag} ${entry.text}`);
      }
      lastSeq = currentSeq;
    }
    if (swarm.completed !== lastCompleted) {
      lastCompleted = swarm.completed;
      write(`progress: ${swarm.completed}/${swarm.total} done, ${swarm.active} active, ${swarm.pending} queued`);
    }
  }, 500);

  return () => {
    clearInterval(interval);
    write(`done: ${swarm.completed}/${swarm.total} tasks, ${fmtDur(Date.now() - swarm.startedAt)}`);
  };
}
