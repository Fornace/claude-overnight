import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { RateLimitWindow, WaveSummary } from "./types.js";
import { renderFrame, renderSteeringFrame } from "./render.js";

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
  dirty: boolean;
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
  private inputMode: "none" | "budget" | "threshold" | "steer" | "ask" = "none";
  private inputBuf = "";
  private started = false;
  private readonly isTTY: boolean;
  private lastSeq = 0;
  private lastCompleted = -1;
  private askState?: AskState;
  private askBusy = false;
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
  setAsk(state: AskState | undefined): void { this.askState = state; }

  /** Signal to the UI whether an ask is in progress (prevents duplicate firings). */
  setAskBusy(busy: boolean): void { this.askBusy = busy; }

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
      try { process.stdin.setRawMode!(false); process.stdin.pause(); } catch {}
    }
    try { process.stdout.write("\x1B[?25h"); } catch {}
    this.started = false;
  }

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
    let frame = "";
    if (this.swarm) {
      frame = renderFrame(this.swarm, this.hasHotkeys(), this.runInfo);
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
    if (this.inputMode === "budget") {
      return `\n  ${chalk.cyan(">")} New budget (remaining sessions): ${this.inputBuf}\u2588`;
    }
    if (this.inputMode === "threshold") {
      return `\n  ${chalk.cyan(">")} New usage cap (0-100%): ${this.inputBuf}\u2588`;
    }
    if (this.inputMode === "steer") {
      return `\n  ${chalk.cyan(">")} ${chalk.bold("Steer next wave")} ${chalk.dim("(Enter to queue, Esc to cancel)")}\n  ${this.inputBuf}\u2588`;
    }
    if (this.inputMode === "ask") {
      return `\n  ${chalk.cyan(">")} ${chalk.bold("Ask the planner")} ${chalk.dim("(Enter to send, Esc to cancel)")}\n  ${this.inputBuf}\u2588`;
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
      const lines = a.answer.split("\n").slice(0, 20);
      out.push(`  ${chalk.bold.green("A:")} ${lines[0] || ""}`);
      for (const ln of lines.slice(1)) out.push(`     ${ln}`);
    }
    return "\n" + out.join("\n");
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
      if (this.inputMode === "budget" || this.inputMode === "threshold") {
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
      if (this.inputMode === "steer" || this.inputMode === "ask") {
        for (const ch of s) {
          if (ch === "\r" || ch === "\n") {
            const text = this.inputBuf.trim();
            const wasAsk = this.inputMode === "ask";
            this.inputMode = "none";
            this.inputBuf = "";
            if (text) {
              if (wasAsk) this.onAsk?.(text);
              else this.onSteer?.(text);
            }
            return;
          }
          if (ch === "\x1B" || ch === "\x03") {
            this.inputMode = "none";
            this.inputBuf = "";
            return;
          }
          if (ch === "\x7F" || ch === "\b") {
            this.inputBuf = this.inputBuf.slice(0, -1);
            continue;
          }
          const code = ch.charCodeAt(0);
          if (code >= 0x20 && code <= 0x7E && this.inputBuf.length < MAX_INPUT_LEN) {
            this.inputBuf += ch;
          }
        }
        return;
      }
      if (s === "b" || s === "B") { this.inputMode = "budget"; this.inputBuf = ""; }
      else if (s === "t" || s === "T") {
        if (this.swarm) { this.inputMode = "threshold"; this.inputBuf = ""; }
      }
      else if ((s === "s" || s === "S") && this.onSteer) {
        this.inputMode = "steer"; this.inputBuf = "";
      }
      else if (s === "?" && this.onAsk && this.swarm && !this.askBusy) {
        this.inputMode = "ask"; this.inputBuf = "";
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
