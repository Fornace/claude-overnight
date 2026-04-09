import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { RateLimitWindow } from "./types.js";
import { renderFrame, renderSteeringFrame } from "./render.js";

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
  private lastSeq = 0;
  private lastCompleted = -1;

  constructor(runInfo: RunInfo, liveConfig?: LiveConfig) {
    this.runInfo = runInfo;
    this.liveConfig = liveConfig;
    this.isTTY = !!process.stdout.isTTY;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupHotkeys();
    this.resumeInterval();
  }

  setWave(swarm: Swarm): void {
    this.swarm = swarm;
    this.steeringText = undefined;
    this.rlGetter = undefined;
    this.lastSeq = 0;
    this.lastCompleted = -1;
  }

  setSteering(rlGetter?: RLGetter): void {
    this.swarm = undefined;
    this.steeringText = "Assessing...";
    this.rlGetter = rlGetter;
  }

  updateText(text: string): void { this.steeringText = text; }

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
