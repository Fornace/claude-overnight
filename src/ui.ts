import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { RateLimitWindow, WaveSummary } from "./types.js";
import { renderFrame, renderSteeringFrame } from "./render.js";
import {
  type InputSegment,
  splitPaste,
  segmentsToString,
  renderSegments,
  appendCharToSegments,
  appendPasteToSegments,
  backspaceSegments,
} from "./cli.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

/** Short-lived context the steering view renders around its live log. */
export interface SteeringContext {
  objective?: string;
  status?: string;
  lastWave?: WaveSummary;
}

/** One scrollback line in the steering event log. */
export interface SteeringEvent { time: number; text: string }

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
  /** Number of pending directives in the steer inbox; displayed as a chip in the hotkey row. */
  pendingSteer?: number;
}

/** Mutable config that can be changed live during execution. */
export interface LiveConfig {
  remaining: number;
  usageCap: number | undefined;
  concurrency: number;
  paused: boolean;
  dirty: boolean;
  /** Overage spend cap ($) — undefined = unlimited. Synced from the [e] hotkey. */
  extraUsageBudget?: number;
}

/** State of an in-flight or recently-completed ask side query. */
export interface AskState {
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
}

type RLGetter = () => { utilization: number; isUsingOverage: boolean; windows: Map<string, RateLimitWindow>; resetsAt?: number };

const MAX_STEERING_EVENTS = 60;
const MAX_INPUT_LEN = 600;
const MAX_ASK_LINES = 40;
let askTempDir: string | undefined;

export class RunDisplay {
  readonly runInfo: RunInfo;
  private liveConfig?: LiveConfig;
  private swarm?: Swarm;
  private steeringActive = false;
  private steeringStatusLine = "Assessing...";
  private steeringEvents: SteeringEvent[] = [];
  private steeringContext?: SteeringContext;
  private rlGetter?: RLGetter;
  private interval?: ReturnType<typeof setInterval>;
  private keyHandler?: (buf: Buffer) => void;
  private inputMode: "none" | "budget" | "threshold" | "concurrency" | "extra" | "steer" | "ask" = "none";
  private inputSegs: InputSegment[] = [];
  private started = false;
  private readonly isTTY: boolean;
  private lastSeq = 0;
  private lastCompleted = -1;
  private askState?: AskState;
  private askBusy = false;
  private askTempFile?: string;
  /** ID of the agent whose detail panel is open; undefined = no detail shown. */
  private selectedAgentId?: number;
  private onSteer?: (text: string) => void;
  private onAsk?: (text: string) => void;

  constructor(
    runInfo: RunInfo,
    liveConfig?: LiveConfig,
    callbacks?: { onSteer?: (text: string) => void; onAsk?: (text: string) => void },
  ) {
    this.runInfo = runInfo;
    this.liveConfig = liveConfig;
    this.onSteer = callbacks?.onSteer;
    this.onAsk = callbacks?.onAsk;
    this.isTTY = !!process.stdout.isTTY;
  }

  /** Replace the ask state. Called by run.ts as the side query streams and completes. */
  setAsk(state: AskState | undefined): void {
    this.askState = state;
    // Clean up previous temp file
    this.clearAskTempFile();
    // Write full answer to temp file when streaming is done and answer is long
    if (state && !state.streaming && !state.error && state.answer) {
      const lines = state.answer.split("\n");
      if (lines.length > MAX_ASK_LINES) {
        try {
          askTempDir = mkdtempSync(join(tmpdir(), "overnight-ask-"));
          this.askTempFile = join(askTempDir, "answer.txt");
          writeFileSync(this.askTempFile, state.answer, "utf8");
        } catch {}
      }
    }
  }

  /** Signal to the UI whether an ask is in progress (prevents duplicate firings). */
  setAskBusy(busy: boolean): void { this.askBusy = busy; }

  /** Cycle the selected agent detail to the next running agent (or first running if none selected). */
  cycleSelectedAgent(): void {
    if (!this.swarm) return;
    const running = this.swarm.agents.filter(a => a.status === "running");
    if (running.length === 0) { this.selectedAgentId = undefined; return; }
    if (this.selectedAgentId == null) { this.selectedAgentId = running[0].id; return; }
    const idx = running.findIndex(a => a.id === this.selectedAgentId);
    this.selectedAgentId = running[(idx + 1) % running.length].id;
  }

  /** Select a specific agent by ID for the detail panel. */
  selectAgent(id: number): void {
    if (!this.swarm) return;
    const agent = this.swarm.agents.find(a => a.id === id);
    if (agent && agent.status === "running") this.selectedAgentId = id;
  }

  /** Clear the agent detail panel. */
  clearSelectedAgent(): void { this.selectedAgentId = undefined; }

  private clearAskTempFile(): void {
    if (this.askTempFile) {
      try { rmSync(this.askTempFile, { force: true }); } catch {}
      if (askTempDir) { try { rmSync(askTempDir, { recursive: true, force: true }); } catch {} }
      this.askTempFile = undefined;
      askTempDir = undefined;
    }
  }

  /** Get the currently selected agent's ID for rendering. */
  getSelectedAgentId(): number | undefined { return this.selectedAgentId; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupHotkeys();
    this.resumeInterval();
  }

  setWave(swarm: Swarm): void {
    this.swarm = swarm;
    this.steeringActive = false;
    this.rlGetter = undefined;
    this.lastSeq = 0;
    this.lastCompleted = -1;
  }

  setSteering(rlGetter?: RLGetter, ctx?: SteeringContext): void {
    this.swarm = undefined;
    this.steeringActive = true;
    this.steeringStatusLine = "Assessing...";
    this.steeringEvents = [];
    this.steeringContext = ctx;
    this.rlGetter = rlGetter;
  }

  /** Replace the single live status line (ticker heartbeat). */
  updateSteeringStatus(text: string): void { this.steeringStatusLine = text; }

  /** Append a discrete, persistent line to the steering scrollback. */
  appendSteeringEvent(text: string): void {
    this.steeringEvents.push({ time: Date.now(), text });
    if (this.steeringEvents.length > MAX_STEERING_EVENTS) this.steeringEvents.shift();
  }

  /** Backwards-compat alias — treats input as the current status line. */
  updateText(text: string): void { this.updateSteeringStatus(text); }

  pause(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
  }

  resume(): void {
    if (!this.started || this.interval) return;
    if (this.isTTY) try { process.stdout.write("\x1B[?25l"); } catch {}
    this.resumeInterval();
  }

  stop(): void {
    this.pause();
    if (this.keyHandler) {
      process.stdin.removeListener("data", this.keyHandler);
      this.keyHandler = undefined;
      try { process.stdout.write("\x1B[?2004l"); } catch {}
      try { process.stdin.setRawMode!(false); process.stdin.pause(); } catch {}
    }
    try { process.stdout.write("\x1B[?25h"); } catch {}
    // Clean up ask temp file
    this.clearAskTempFile();
    this.started = false;
  }

  private resumeInterval(): void {
    if (this.interval) return;
    if (!this.isTTY) {
      this.interval = setInterval(() => this.plainTick(), 500);
      return;
    }
    try { process.stdout.write("\x1B[?25l\x1B[H\x1B[J"); } catch { return; }
    this.interval = setInterval(() => this.flush(), 250);
  }

  /** Write the full frame to stdout, clamped to terminal height. */
  private flush(): void {
    try {
      const maxRows = (process.stdout.rows || 40) - 1;
      const frame = this.render();
      const lines = frame.split("\n");
      process.stdout.write("\x1B[H\x1B[J");
      process.stdout.write(lines.length > maxRows ? lines.slice(0, maxRows).join("\n") : frame);
    } catch { this.pause(); }
  }

  private render(): string {
    let frame = "";
    if (this.swarm) {
      frame = renderFrame(this.swarm, this.hasHotkeys(), this.runInfo, this.selectedAgentId);
    } else if (this.steeringActive) {
      frame = renderSteeringFrame(this.runInfo, {
        statusLine: this.steeringStatusLine,
        events: this.steeringEvents,
        context: this.steeringContext,
      }, this.hasHotkeys(), this.rlGetter);
    } else {
      return "";
    }
    frame += this.renderInputPrompt();
    frame += this.renderAskPanel();
    return frame;
  }

  private renderInputPrompt(): string {
    if (this.inputMode === "none") return "";
    const rendered = renderSegments(this.inputSegs);
    if (this.inputMode === "budget") {
      return `\n  ${chalk.cyan(">")} New budget (remaining sessions): ${rendered}\u2588`;
    }
    if (this.inputMode === "threshold") {
      return `\n  ${chalk.cyan(">")} New usage cap (0-100%): ${rendered}\u2588`;
    }
    if (this.inputMode === "concurrency") {
      return `\n  ${chalk.cyan(">")} New concurrency (min 1): ${rendered}\u2588`;
    }
    if (this.inputMode === "extra") {
      return `\n  ${chalk.cyan(">")} Extra usage $ cap (0 = stop on overage): ${rendered}\u2588`;
    }
    if (this.inputMode === "steer") {
      return `\n  ${chalk.cyan(">")} ${chalk.bold("Steer next wave")} ${chalk.dim("(Enter to queue, Esc to cancel)")}\n  ${rendered}\u2588`;
    }
    if (this.inputMode === "ask") {
      return `\n  ${chalk.cyan(">")} ${chalk.bold("Ask the planner")} ${chalk.dim("(Enter to send, Esc to cancel)")}\n  ${rendered}\u2588`;
    }
    return "";
  }

  private renderAskPanel(): string {
    const a = this.askState;
    if (!a) return "";
    const out: string[] = ["", chalk.gray("  \u2500\u2500\u2500 Ask " + "\u2500".repeat(40))];
    out.push(`  ${chalk.bold.cyan("Q:")} ${a.question}`);
    if (a.error) {
      out.push(`  ${chalk.red("A:")} ${chalk.red(a.error)}`);
    } else if (a.streaming) {
      out.push(`  ${chalk.dim("A: " + (a.answer || "thinking..."))}`);
    } else {
      const allLines = a.answer.split("\n");
      const showLines = allLines.slice(0, MAX_ASK_LINES);
      out.push(`  ${chalk.bold.green("A:")} ${showLines[0] || ""}`);
      for (const ln of showLines.slice(1)) out.push(`     ${ln}`);
      if (allLines.length > MAX_ASK_LINES) {
        const overflow = allLines.length - MAX_ASK_LINES;
        out.push(chalk.dim(`     \u2026 + ${overflow} more lines`));
        if (this.askTempFile) {
          out.push(chalk.dim("  \u23CE Enter to reveal full answer in Finder"));
        }
      }
    }
    return "\n" + out.join("\n");
  }

  private hasHotkeys(): boolean {
    return !!this.liveConfig && !!process.stdin.isTTY;
  }

  private setupHotkeys(): void {
    if (!this.liveConfig || !process.stdin.isTTY) return;
    try { process.stdin.setRawMode!(true); process.stdin.resume(); } catch { return; }
    try { process.stdout.write("\x1B[?2004h"); } catch {}

    this.keyHandler = (buf: Buffer) => {
      const chunk = buf.toString();
      let dirty = false;
      for (const seg of splitPaste(chunk)) {
        if (seg.type === "paste") {
          if (this.handlePaste(seg.text)) dirty = true;
        } else {
          if (this.handleTyped(seg.text)) dirty = true;
        }
      }
      if (dirty) this.flush();
    };
    process.stdin.on("data", this.keyHandler);
  }

  /** Handle a pasted block. Returns true if the frame needs a redraw. */
  private handlePaste(text: string): boolean {
    if (this.inputMode === "budget" || this.inputMode === "threshold" || this.inputMode === "concurrency" || this.inputMode === "extra") {
      const clean = text.replace(/[^0-9.]/g, "");
      if (clean) appendCharToSegments(this.inputSegs, clean);
      return !!clean;
    }
    if (this.inputMode === "steer" || this.inputMode === "ask") {
      if (segmentsToString(this.inputSegs).length + text.length > MAX_INPUT_LEN) return false;
      appendPasteToSegments(this.inputSegs, text);
      return true;
    }
    return false;
  }

  /** Handle a typed (non-pasted) chunk. Returns true if the frame needs a redraw. */
  private handleTyped(s: string): boolean {
    const lc = this.liveConfig!;
    // Enter in hotkey mode reveals truncated ask answer in Finder
    if (this.inputMode === "none" && this.askTempFile) {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          try { execSync(`open -R ${JSON.stringify(this.askTempFile)}`); } catch {}
          return true;
        }
      }
    }
    if (this.inputMode === "budget" || this.inputMode === "threshold" || this.inputMode === "concurrency" || this.inputMode === "extra") {
      let dirty = false;
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          const val = parseFloat(segmentsToString(this.inputSegs));
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
          } else if (this.inputMode === "concurrency" && !isNaN(val) && val >= 1) {
            const n = Math.round(val);
            lc.concurrency = n;
            lc.dirty = true;
            this.swarm?.setConcurrency(n);
          } else if (this.inputMode === "extra" && !isNaN(val) && val >= 0) {
            lc.extraUsageBudget = val;
            lc.dirty = true;
            this.swarm?.setExtraUsageBudget(val);
          }
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        if (ch === "\x03") {
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        // ESC cancels input mode
        if (ch === "\x1B") {
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        if (ch === "\x7F") { backspaceSegments(this.inputSegs); dirty = true; continue; }
        if (/^[0-9.]$/.test(ch)) { appendCharToSegments(this.inputSegs, ch); dirty = true; }
      }
      return dirty;
    }
    if (this.inputMode === "steer" || this.inputMode === "ask") {
      let dirty = false;
      for (let ci = 0; ci < s.length; ci++) {
        const ch = s[ci];
        if (ch === "\r" || ch === "\n") {
          const text = segmentsToString(this.inputSegs).trim();
          const wasAsk = this.inputMode === "ask";
          this.inputMode = "none";
          this.inputSegs = [];
          if (text) {
            if (wasAsk) this.onAsk?.(text);
            else this.onSteer?.(text);
          }
          return true;
        }
        if (ch === "\x03") {
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        // ESC cancels — consume this byte and any following ANSI sequence bytes
        if (ch === "\x1B") {
          this.inputMode = "none";
          this.inputSegs = [];
          // Skip any remaining ANSI sequence bytes (e.g. [A for arrow keys)
          while (ci + 1 < s.length) {
            const next = s[ci + 1];
            const nc = next.charCodeAt(0);
            ci++;
            if ((nc >= 0x40 && nc <= 0x7E) || nc === 0x7F) break; // final byte
          }
          return true;
        }
        if (ch === "\x7F" || ch === "\b") {
          backspaceSegments(this.inputSegs);
          dirty = true;
          continue;
        }
        const code = ch.charCodeAt(0);
        if (code < 0x20) continue; // control chars
        if (code >= 0x7F && code < 0xA0) continue; // DEL + C1 controls
        if (code >= 0x20 && code <= 0x7E && segmentsToString(this.inputSegs).length < MAX_INPUT_LEN) {
          appendCharToSegments(this.inputSegs, ch);
          dirty = true;
        }
      }
      return dirty;
    }
    // Hotkey mode — only accept single printable ASCII characters
    // Skip ESC and ANSI sequences entirely
    if (s.length > 1 && (s[0] === "\x1B" || s.charCodeAt(0) < 0x20)) return false;
    if (s.length !== 1) return false;
    const key = s[0];
    const code = key.charCodeAt(0);
    if (code < 0x20 || code > 0x7E) return false;
    if (key === "\x1B" && this.askState && !this.askState.streaming) {
      this.askState = undefined;
      this.clearAskTempFile();
      return false;
    }
    if (key === "b" || key === "B") { this.inputMode = "budget"; this.inputSegs = []; return true; }
    if (key === "t" || key === "T") {
      if (this.swarm) { this.inputMode = "threshold"; this.inputSegs = []; return true; }
      return false;
    }
    if (key === "c" || key === "C") {
      if (this.swarm) { this.inputMode = "concurrency"; this.inputSegs = []; return true; }
      return false;
    }
    if (key === "e" || key === "E") {
      if (this.swarm) { this.inputMode = "extra"; this.inputSegs = []; return true; }
      return false;
    }
    if (key === "p" || key === "P") {
      if (this.swarm) {
        const next = !this.swarm.paused;
        this.swarm.setPaused(next);
        lc.paused = next;
        lc.dirty = true;
        return true;
      }
      return false;
    }
    if ((key === "f" || key === "F") && this.swarm && this.swarm.failed > 0 && this.swarm.active > 0) {
      this.swarm.requeueFailed();
      return false;
    }
    if ((key === "r" || key === "R") && this.swarm && this.swarm.rateLimitPaused > 0) {
      this.swarm.retryRateLimitNow();
      return true;
    }
    if ((key === "s" || key === "S") && this.onSteer) {
      this.inputMode = "steer"; this.inputSegs = []; return true;
    }
    if (key === "?" && this.onAsk && this.swarm && !this.askBusy) {
      if (this.askState && !this.askState.streaming) { this.askState = undefined; this.clearAskTempFile(); return false; }
      this.inputMode = "ask"; this.inputSegs = []; return true;
    }
    // [d] cycle agent detail panel
    if ((key === "d" || key === "D") && this.swarm && this.swarm.active > 0) {
      if (this.selectedAgentId != null) this.cycleSelectedAgent();
      else this.cycleSelectedAgent();
      return true;
    }
    // ESC closes detail panel
    if (key === "\x1B" && this.selectedAgentId != null) {
      this.clearSelectedAgent();
      return true;
    }
    // Number keys 0-9 select a specific agent by row index in the visible table
    if (/^[0-9]$/.test(key) && this.swarm) {
      const n = parseInt(key);
      const running = this.swarm.agents.filter(a => a.status === "running");
      if (n < running.length) { this.selectAgent(running[n].id); return true; }
    }
    if (key === "q" || key === "Q" || key === "\x03") {
      if (this.swarm) {
        if (this.swarm.aborted) process.exit(0);
        this.swarm.abort();
      } else {
        process.exit(0);
      }
    }
    return false;
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
