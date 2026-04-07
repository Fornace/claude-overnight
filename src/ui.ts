import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { AgentState, RateLimitWindow } from "./types.js";

/** Cumulative run-level stats — mutable, updated between phases. */
export interface RunInfo {
  accIn: number;
  accOut: number;
  accCost: number;
  accCompleted: number;
  accFailed: number;
  sessionsBudget: number;
  waveNum: number;
  remaining: number;
  model?: string;
  startedAt: number;
}

/** Mutable config that can be changed live during execution. */
export interface LiveConfig {
  remaining: number;
  usageCap: number | undefined;
  dirty: boolean;
}

type RLGetter = () => { utilization: number; isUsingOverage: boolean; windows: Map<string, RateLimitWindow>; resetsAt?: number };

const SPINNER = ["|", "/", "-", "\\"] as const;
const WINDOW_SHORT_NAMES: Record<string, string> = {
  five_hour: "5h", seven_day: "7d", seven_day_opus: "7d op",
  seven_day_sonnet: "7d sn", overage: "extra",
};

// ── Unified display ──

export class RunDisplay {
  readonly runInfo: RunInfo;
  private liveConfig?: LiveConfig;
  private swarm?: Swarm;
  private steeringText?: string;
  private rlGetter?: RLGetter;
  private interval?: ReturnType<typeof setInterval>;
  private keyHandler?: (buf: Buffer) => void;
  private inputMode: "none" | "budget" | "threshold" = "none";
  private inputBuf = "";
  private started = false;
  private readonly isTTY: boolean;
  // Plain-log state
  private lastSeq = 0;
  private lastCompleted = -1;

  constructor(runInfo: RunInfo, liveConfig?: LiveConfig) {
    this.runInfo = runInfo;
    this.liveConfig = liveConfig;
    this.isTTY = !!process.stdout.isTTY;
  }

  /** Start the persistent render loop. Call once at the beginning of the run. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupHotkeys();
    this.resumeInterval();
  }

  /** Switch to wave mode — show agent table + events. */
  setWave(swarm: Swarm): void {
    this.swarm = swarm;
    this.steeringText = undefined;
    this.rlGetter = undefined;
    this.lastSeq = 0;
    this.lastCompleted = -1;
  }

  /** Switch to steering mode — show assessment text. */
  setSteering(rlGetter?: RLGetter): void {
    this.swarm = undefined;
    this.steeringText = "Assessing...";
    this.rlGetter = rlGetter;
  }

  /** Update the steering text. */
  updateText(text: string): void { this.steeringText = text; }

  /** Pause rendering (e.g. to print a summary). */
  pause(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
  }

  /** Resume rendering after a pause. */
  resume(): void {
    if (!this.started || this.interval) return;
    if (this.isTTY) try { process.stdout.write("\x1B[?25l"); } catch {}
    this.resumeInterval();
  }

  /** Stop and clean up. */
  stop(): void {
    this.pause();
    if (this.keyHandler) {
      process.stdin.removeListener("data", this.keyHandler);
      this.keyHandler = undefined;
      try { process.stdin.setRawMode!(false); process.stdin.pause(); } catch {}
    }
    try { process.stdout.write("\x1B[?25h"); } catch {}
    this.started = false;
  }

  // ── Internals ──

  private resumeInterval(): void {
    if (this.interval) return;
    if (!this.isTTY) {
      this.interval = setInterval(() => this.plainTick(), 500);
      return;
    }
    try { process.stdout.write("\x1B[?25l\x1B[H\x1B[J"); } catch { return; }
    this.interval = setInterval(() => {
      try {
        process.stdout.write("\x1B[H\x1B[J");
        process.stdout.write(this.render());
      } catch { this.pause(); }
    }, 250);
  }

  private render(): string {
    if (this.swarm) {
      let frame = renderFrame(this.swarm, this.hasHotkeys(), this.runInfo);
      if (this.inputMode !== "none") {
        const label = this.inputMode === "budget" ? "New budget (remaining sessions)" : "New usage cap (0-100%)";
        frame += `\n  ${chalk.cyan(">")} ${label}: ${this.inputBuf}\u2588`;
      }
      return frame;
    }
    if (this.steeringText != null) {
      let frame = renderSteeringFrame(this.runInfo, this.steeringText, this.hasHotkeys(), this.rlGetter);
      if (this.inputMode === "budget") {
        frame += `\n  ${chalk.cyan(">")} New budget (remaining sessions): ${this.inputBuf}\u2588`;
      }
      return frame;
    }
    return "";
  }

  private hasHotkeys(): boolean {
    return !!this.liveConfig && !!process.stdin.isTTY;
  }

  private setupHotkeys(): void {
    if (!this.liveConfig || !process.stdin.isTTY) return;
    try { process.stdin.setRawMode!(true); process.stdin.resume(); } catch { return; }

    const lc = this.liveConfig;
    this.keyHandler = (buf: Buffer) => {
      const s = buf.toString();
      if (this.inputMode !== "none") {
        if (s === "\r" || s === "\n") {
          const val = parseFloat(this.inputBuf);
          if (this.inputMode === "budget" && !isNaN(val) && val > 0) {
            lc.remaining = Math.round(val);
            lc.dirty = true;
            this.swarm?.log(-1, `Budget changed to ${lc.remaining} remaining`);
          } else if (this.inputMode === "threshold" && !isNaN(val) && val >= 0 && val <= 100) {
            const frac = val / 100;
            lc.usageCap = frac > 0 ? frac : undefined;
            lc.dirty = true;
            if (this.swarm) this.swarm.usageCap = lc.usageCap;
            this.swarm?.log(-1, `Usage cap changed to ${val > 0 ? val + "%" : "unlimited"}`);
          }
          this.inputMode = "none";
          this.inputBuf = "";
        } else if (s === "\x1B" || s === "\x03") {
          this.inputMode = "none";
          this.inputBuf = "";
        } else if (s === "\x7F") {
          this.inputBuf = this.inputBuf.slice(0, -1);
        } else if (/^[0-9.]$/.test(s)) {
          this.inputBuf += s;
        }
        return;
      }
      if (s === "b" || s === "B") { this.inputMode = "budget"; this.inputBuf = ""; }
      else if (s === "t" || s === "T") {
        if (this.swarm) { this.inputMode = "threshold"; this.inputBuf = ""; }
      }
      else if (s === "q" || s === "Q" || s === "\x03") {
        if (this.swarm) {
          if (this.swarm.aborted) process.exit(0);
          this.swarm.abort();
        } else {
          process.exit(0);
        }
      }
    };
    process.stdin.on("data", this.keyHandler);
  }

  private plainTick(): void {
    if (!this.swarm) return;
    const swarm = this.swarm;
    const write = (line: string) => { try { process.stdout.write(line + "\n"); } catch {} };
    const currentSeq = swarm.logSequence;
    if (currentSeq > this.lastSeq) {
      const newCount = currentSeq - this.lastSeq;
      const available = swarm.logs.length;
      const toShow = Math.min(newCount, available);
      for (const entry of swarm.logs.slice(available - toShow)) {
        const t = new Date(entry.time).toLocaleTimeString("en", { hour12: false });
        const tag = entry.agentId < 0 ? "[sys]" : `[${entry.agentId}]`;
        write(`${t} ${tag} ${entry.text}`);
      }
      this.lastSeq = currentSeq;
    }
    if (swarm.completed !== this.lastCompleted) {
      this.lastCompleted = swarm.completed;
      write(`progress: ${swarm.completed}/${swarm.total} done, ${swarm.active} active, ${swarm.pending} queued`);
    }
  }
}

// ── Pure render functions ──

function colorEvent(text: string): string {
  if (text === "Done" || text.startsWith("Merged ") || text.startsWith("Committed ")) return chalk.green(text);
  if (text.startsWith("Rate:") || text.startsWith("Rate limited") || text.startsWith("Soft throttle")) return chalk.magenta(text);
  if (/error|fail|conflict/i.test(text)) return chalk.red(text);
  if (!text.includes(" ") && text.length <= 40) return chalk.yellow(text);
  return text;
}

/** Render the shared header block (title + stats + usage bars). */
function renderHeader(
  out: string[],
  w: number,
  p: {
    model?: string;
    phase: string;
    barPct: number;
    barLabel: string;
    active: number;
    queued: number;
    startedAt: number;
    totalIn: number;
    totalOut: number;
    totalCost: number;
    waveNum: number;
    sessionsUsed: number;
    sessionsBudget: number;
    remaining: number;
  },
): void {
  const barW = Math.min(30, w - 50);
  const filled = Math.round(p.barPct * barW);
  const bar = chalk.green("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(barW - filled));
  const modelTag = p.model ? chalk.dim(` [${p.model}]`) : "";
  const phaseTag = p.phase ? " " + p.phase : "";

  out.push("");
  out.push(
    `  ${chalk.bold.white("CLAUDE OVERNIGHT")}${modelTag}${phaseTag}  ${bar}  ` +
      `${p.barLabel}  ` +
      (p.active > 0 ? chalk.cyan(`${p.active} active`) + "  " : "") +
      (p.queued > 0 ? chalk.gray(`${p.queued} queued`) + "  " : "") +
      chalk.gray(`\u23F1 ${fmtDur(Date.now() - p.startedAt)}`),
  );

  // Stats line
  const tokIn = fmtTokens(p.totalIn);
  const tokOut = fmtTokens(p.totalOut);
  const costStr = p.totalCost > 0 ? chalk.yellow(`$${p.totalCost.toFixed(2)}`) : "";
  const waveLabel = p.waveNum >= 0 ? `wave ${p.waveNum + 1} \u00b7 ` : "";
  const sessionStr = chalk.dim(`  ${waveLabel}`) +
    chalk.white(`${p.sessionsUsed}/${p.sessionsBudget}`) +
    chalk.dim(` sessions \u00b7 ${p.remaining} left`);
  out.push(
    chalk.gray(`  \u2191 ${tokIn} in  \u2193 ${tokOut} out`) +
      (costStr ? `  ${costStr}` : "") +
      sessionStr,
  );
}

function renderFrame(swarm: Swarm, showHotkeys: boolean, runInfo?: RunInfo): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
  const out: string[] = [];

  // ── Header ──
  const stoppingTag = swarm.aborted ? chalk.yellow("STOPPING") : "";
  const phaseLabel =
    swarm.phase === "planning"
      ? chalk.magenta("PLANNING")
      : swarm.phase === "merging"
        ? chalk.yellow("MERGING")
        : "";
  const phase = [phaseLabel, stoppingTag].filter(Boolean).join(" ");

  const waveUsed = swarm.completed + swarm.failed;
  renderHeader(out, w, {
    model: runInfo?.model ?? swarm.model,
    phase,
    barPct: swarm.total > 0 ? swarm.completed / swarm.total : 0,
    barLabel: `${swarm.completed}/${swarm.total}`,
    active: swarm.active,
    queued: swarm.pending,
    startedAt: runInfo?.startedAt ?? swarm.startedAt,
    totalIn: (runInfo?.accIn ?? 0) + swarm.totalInputTokens,
    totalOut: (runInfo?.accOut ?? 0) + swarm.totalOutputTokens,
    totalCost: (runInfo?.accCost ?? swarm.baseCostUsd) + swarm.totalCostUsd,
    waveNum: runInfo?.waveNum ?? -1,
    sessionsUsed: (runInfo ? runInfo.accCompleted + runInfo.accFailed : 0) + waveUsed,
    sessionsBudget: runInfo?.sessionsBudget ?? swarm.total,
    remaining: Math.max(0, (runInfo?.remaining ?? swarm.total) - waveUsed),
  });

  // ── Usage bar(s) ──
  const windows = Array.from(swarm.rateLimitWindows.values());
  const rlPct = swarm.rateLimitUtilization;
  if (rlPct > 0 || swarm.rateLimitResetsAt || swarm.cappedOut || windows.length > 0) {
    const barW = Math.min(30, w - 40);
    const capFrac = swarm.usageCap;
    const capMark = capFrac != null && capFrac < 1 ? Math.round(capFrac * barW) : -1;

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
          label = chalk.red("Extra usage blocked \u2014 stopping");
        } else {
          label = chalk.yellow(`Capped at ${capFrac != null ? Math.round(capFrac * 100) : 100}% \u2014 finishing active`);
        }
      } else if (swarm.rateLimitResetsAt && swarm.rateLimitResetsAt > Date.now()) {
        const waitSec = Math.ceil((swarm.rateLimitResetsAt - Date.now()) / 1000);
        const mm = Math.floor(waitSec / 60);
        const ss = waitSec % 60;
        label = chalk.red(`Waiting for reset ${mm > 0 ? `${mm}m ${ss}s` : `${ss}s`}`);
      }
      if (swarm.isUsingOverage && !swarm.cappedOut) {
        label += chalk.red(" [EXTRA USAGE]");
      }
      const prefix = windowLabel ? chalk.dim(windowLabel.padEnd(6)) : chalk.dim("Usage ");
      out.push(`  ${prefix}${barStr}  ${label}`);
    };

    if (windows.length > 1) {
      const cycleIdx = Math.floor(Date.now() / 3000) % windows.length;
      const win = windows[cycleIdx];
      const shortName = WINDOW_SHORT_NAMES[win.type] ?? win.type.replace(/_/g, " ");
      renderBar(win.utilization, shortName);
      const dots = windows.map((_, i) => i === cycleIdx ? "\u25CF" : "\u25CB").join("");
      out[out.length - 1] += chalk.dim(`  ${dots}`);
    } else {
      renderBar(rlPct);
    }
  }

  // ── Extra usage budget bar ──
  if (swarm.isUsingOverage && swarm.extraUsageBudget != null && swarm.extraUsageBudget > 0) {
    const barW = Math.min(30, w - 40);
    const pct = Math.min(1, swarm.overageCostUsd / swarm.extraUsageBudget);
    const filled = Math.round(pct * barW);
    let barStr = "";
    for (let i = 0; i < barW; i++) {
      if (i < filled) barStr += pct > 0.9 ? chalk.red("\u2588") : pct > 0.75 ? chalk.yellow("\u2588") : chalk.magenta("\u2588");
      else barStr += chalk.gray("\u2591");
    }
    const label = swarm.cappedOut
      ? chalk.red(`$${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget} \u2014 budget hit`)
      : `$${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget}`;
    out.push(`  ${chalk.dim("Extra ")}${barStr}  ${label}`);
  }

  out.push("");

  // ── Agent table ──
  const running = swarm.agents.filter((a) => a.status === "running");
  const finished = swarm.agents.filter((a) => a.status !== "running");
  const showFinished = finished.slice(-Math.max(2, 12 - running.length));
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
    for (const a of show) out.push(fmtRow(a, w));
    if (swarm.pending > 0) out.push(chalk.gray(`  ... + ${swarm.pending} queued`));
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
  out.push(chalk.gray("  \u2500\u2500\u2500 Events " + "\u2500".repeat(Math.min(w - 16, 90))));
  const logN = Math.min(10, swarm.logs.length);
  for (const entry of swarm.logs.slice(-logN)) {
    const t = new Date(entry.time).toLocaleTimeString("en", { hour12: false });
    const tag = entry.agentId < 0 ? chalk.magenta("[sys]") : chalk.cyan(`[${entry.agentId}]`);
    out.push(chalk.gray(`  ${t} `) + tag + ` ${colorEvent(truncate(entry.text, w - 22))}`);
  }

  if (showHotkeys) out.push(chalk.dim("  [b] budget  [t] threshold  [q] stop"));
  out.push("");
  return out.join("\n");
}

function renderSteeringFrame(runInfo: RunInfo, steeringText: string, showHotkeys: boolean, rlGetter?: RLGetter): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
  const out: string[] = [];

  const totalUsed = runInfo.accCompleted + runInfo.accFailed;
  renderHeader(out, w, {
    model: runInfo.model,
    phase: chalk.magenta("STEERING"),
    barPct: runInfo.sessionsBudget > 0 ? totalUsed / runInfo.sessionsBudget : 0,
    barLabel: `${totalUsed}/${runInfo.sessionsBudget}`,
    active: 0,
    queued: 0,
    startedAt: runInfo.startedAt,
    totalIn: runInfo.accIn,
    totalOut: runInfo.accOut,
    totalCost: runInfo.accCost,
    waveNum: runInfo.waveNum,
    sessionsUsed: totalUsed,
    sessionsBudget: runInfo.sessionsBudget,
    remaining: runInfo.remaining,
  });

  // Usage bar from planner rate limit
  const rl = rlGetter?.();
  if (rl && (rl.utilization > 0 || rl.windows.size > 0)) {
    const rlBarW = Math.min(30, w - 40);
    const renderBar = (pct: number, label?: string) => {
      const f = Math.round(pct * rlBarW);
      let barStr = "";
      for (let i = 0; i < rlBarW; i++) {
        if (i < f) barStr += pct > 0.9 ? chalk.red("\u2588") : pct > 0.75 ? chalk.yellow("\u2588") : chalk.blue("\u2588");
        else barStr += chalk.gray("\u2591");
      }
      let lbl = `${Math.round(pct * 100)}% used`;
      if (rl.isUsingOverage) lbl += chalk.red(" [EXTRA USAGE]");
      if (rl.resetsAt && rl.resetsAt > Date.now()) {
        const waitSec = Math.ceil((rl.resetsAt - Date.now()) / 1000);
        const mm = Math.floor(waitSec / 60), ss = waitSec % 60;
        lbl = chalk.red(`Waiting for reset ${mm > 0 ? `${mm}m ${ss}s` : `${ss}s`}`);
      }
      const prefix = label ? chalk.dim(label.padEnd(6)) : chalk.dim("Usage ");
      out.push(`  ${prefix}${barStr}  ${lbl}`);
    };
    if (rl.windows.size > 1) {
      const wins = Array.from(rl.windows.values());
      const idx = Math.floor(Date.now() / 3000) % wins.length;
      const shortName = wins[idx].type.replace(/_/g, " ").slice(0, 5);
      renderBar(wins[idx].utilization, shortName);
    } else {
      renderBar(rl.utilization);
    }
  }

  out.push("");
  out.push(chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, 60))));
  const clean = steeringText.replace(/\n/g, " ");
  const maxTextW = w - 8;
  out.push(`  ${chalk.cyan("\u25C6")} ${clean.length > maxTextW ? clean.slice(0, maxTextW - 1) + "\u2026" : clean}`);
  out.push("");

  if (showHotkeys) out.push(chalk.dim("  [b] budget  [q] stop"));
  out.push("");
  return out.join("\n");
}

export function renderSummary(swarm: Swarm): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
  const out: string[] = [];

  const fixedW = 3 + 6 + 8 + 5 + 5 + 8 + 12 + 2;
  const taskW = Math.max(10, w - fixedW);

  const hdr = chalk.gray(
    "  " + "#".padStart(3) + "  " + "Status".padEnd(6) + "  " + "Task".padEnd(taskW) +
    "  " + "Duration".padStart(8) + "  " + "Files".padStart(5) + "  " + "Tools".padStart(5) + "  " + "Cost".padStart(8),
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

  let totalDurMs = 0, totalFiles = 0, totalTools = 0, totalCost = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) out.push(thinSep);
    for (const a of groups[gi]) {
      const id = String(a.id).padStart(3);
      const ok = a.status === "done";
      const status = ok ? chalk.green("\u2713 done") : a.status === "running" ? chalk.blue("~ run ") : chalk.red("\u2717 err ");
      const task = truncate(a.task.prompt, taskW).padEnd(taskW);
      const durMs = a.startedAt != null ? (a.finishedAt ?? Date.now()) - a.startedAt : 0;
      const dur = fmtDur(durMs).padStart(8);
      const files = String(a.filesChanged ?? 0).padStart(5);
      const tools = String(a.toolCalls).padStart(5);
      const cost = a.costUsd != null ? `$${a.costUsd.toFixed(3)}`.padStart(8) : "".padStart(8);
      totalDurMs += durMs; totalFiles += a.filesChanged ?? 0; totalTools += a.toolCalls; totalCost += a.costUsd ?? 0;
      const color = ok ? chalk.white : a.status === "running" ? chalk.blue : chalk.red;
      out.push(color(`  ${id}  ${status}  ${task}  ${dur}  ${files}  ${tools}  ${cost}`));
    }
  }

  out.push(sep);
  const label = `${swarm.agents.length} tasks`.padEnd(taskW);
  out.push(chalk.bold(
    `  ${"".padStart(3)}  ${"Total ".padEnd(6)}  ${label}  ${fmtDur(totalDurMs).padStart(8)}  ${String(totalFiles).padStart(5)}  ${String(totalTools).padStart(5)}  ${`$${totalCost.toFixed(3)}`.padStart(8)}`,
  ));
  out.push("");
  return out.join("\n");
}

// ── Formatting helpers ──

function fmtRow(a: AgentState, w: number): string {
  const id = String(a.id).padStart(3);
  const elapsed = a.status === "running" && a.startedAt ? " " + chalk.dim(fmtDur(Date.now() - a.startedAt)) : "";
  const spin = SPINNER[Math.floor(Date.now() / 250) % SPINNER.length];
  const icon = a.status === "running"
    ? chalk.blue(`${spin} run`) + elapsed
    : a.status === "done" ? chalk.green("\u2713 done") : chalk.red("\u2717 err ");
  const taskW = Math.max(20, Math.min(36, w - 50));
  const task = truncate(a.task.prompt, taskW).padEnd(taskW);

  let action: string;
  if (a.currentTool) {
    action = chalk.yellow(a.currentTool);
  } else if (a.status === "running") {
    action = chalk.dim(truncate(a.lastText || "...", 24));
  } else if (a.status === "done") {
    const dur = fmtDur((a.finishedAt || Date.now()) - (a.startedAt || Date.now()));
    const cost = a.costUsd != null ? ` $${a.costUsd.toFixed(3)}` : "";
    const files = a.filesChanged != null && a.filesChanged > 0 ? chalk.dim(` ${a.filesChanged}f`) : "";
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
