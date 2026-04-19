import { EventEmitter } from "events";
import { type TranscriptEvent, onStreamEvent } from "./transcripts.js";

export type StallType = "thinking" | "action" | "betweenTool";

export interface StallThresholds {
  thinking: number;
  action: number;
  betweenTool: number;
}

/** Minimal sink — StreamSink satisfies this; planner passes an inline stub. */
export interface StallGuardSink {
  lastByteAt: number;
  /** Empty string disables the transcript-bus subscription (planner mode). */
  streamId: string;
  finished: boolean;
  path?: string;
}

export type FallbackProviderFn = (model: string | undefined) => Record<string, string> | undefined;

const DEFAULT_THRESHOLDS: StallThresholds = {
  thinking: 30_000,
  action: 60_000,
  betweenTool: 45_000,
};

const TICK_MS = 5_000;
const PROVIDER_WINDOW_MS = 15_000;
/** ~300 tokens @ 4 chars/token. Below this, salvage isn't worth a resume prompt. */
const MIN_SALVAGE_CHARS = 1200;

export class StallError extends Error {
  constructor(
    public readonly elapsedMs: number,
    public readonly thresholdMs: number,
    public readonly activityType: StallType,
    public readonly salvagedText?: string,
  ) {
    super(`StallGuard: ${activityType} stalled after ${Math.round(elapsedMs / 1000)}s (threshold ${Math.round(thresholdMs / 1000)}s)`);
    this.name = "StallError";
  }
}

export function isStallError(err: unknown): err is StallError {
  return err instanceof StallError;
}

function classifyType(t: string): StallType {
  if (t === "user" || t === "tool_result") return "betweenTool";
  if (t === "tool_use" || t === "tool_call") return "action";
  return "thinking";
}

export class StallGuard extends EventEmitter {
  readonly thresholds: StallThresholds;
  private _sink: StallGuardSink;
  private _abort: AbortController;
  private _interval?: NodeJS.Timeout;
  private _stopped = false;
  private _unsub?: () => void;
  private _salvagedText?: string;
  private _assembledDelta = "";
  private _lastActivityType: StallType = "thinking";

  constructor(sink: StallGuardSink, abortController: AbortController, thresholds: Partial<StallThresholds> = {}) {
    super();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this._sink = sink;
    this._abort = abortController;
    if (sink.streamId) {
      this._unsub = onStreamEvent(sink.streamId, (evt) => this._onEvent(evt));
    }
    this._interval = setInterval(() => this._tick(), TICK_MS);
    StallMonitor.instance.register(this);
  }

  private _onEvent(evt: TranscriptEvent): void {
    this._lastActivityType = classifyType(evt.type);
    const payload = evt.payload;
    if (payload?.type === "assistant" && typeof payload.delta === "string") {
      this._assembledDelta += payload.delta;
    }
  }

  private _tick(): void {
    if (this._stopped || this._sink.finished) return;
    const kind = this._lastActivityType;
    const threshold = this.thresholds[kind];
    const elapsed = Date.now() - this._sink.lastByteAt;
    if (elapsed < threshold) return;

    if (this._assembledDelta.length >= MIN_SALVAGE_CHARS) this._salvagedText = this._assembledDelta;
    const error = new StallError(elapsed, threshold, kind, this._salvagedText);
    this.emit("stall", error);
    this._abort.abort(error);
    this.stop();
  }

  get salvagedText(): string | undefined { return this._salvagedText; }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    if (this._interval) clearInterval(this._interval);
    this._unsub?.();
    StallMonitor.instance.unregister(this);
  }
}

export class StallMonitor extends EventEmitter {
  private static _instance?: StallMonitor;
  private _active = new Map<StallGuard, number>();
  private _peakActive = 0;
  private _outageActive = false;
  private _fallbackProvider?: FallbackProviderFn;

  static get instance(): StallMonitor {
    if (!StallMonitor._instance) StallMonitor._instance = new StallMonitor();
    return StallMonitor._instance;
  }
  static reset(): void { StallMonitor._instance = undefined; }

  setFallbackProvider(fn: FallbackProviderFn): void { this._fallbackProvider = fn; }
  getFallbackEnv(model: string | undefined): Record<string, string> | undefined {
    return this._fallbackProvider?.(model);
  }
  get outageActive(): boolean { return this._outageActive; }
  resetOutage(): void { this._outageActive = false; }
  get activeCount(): number { return this._active.size; }

  register(guard: StallGuard): void {
    guard.on("stall", () => this._onStall(guard));
    this._active.set(guard, 0);
    if (this._active.size > this._peakActive) this._peakActive = this._active.size;
  }
  unregister(guard: StallGuard): void { this._active.delete(guard); }

  private _onStall(guard: StallGuard): void {
    this._active.set(guard, Date.now());
    if (this._outageActive || this._peakActive === 0) return;
    const now = Date.now();
    let stalled = 0;
    for (const t of this._active.values()) if (t > 0 && now - t <= PROVIDER_WINDOW_MS) stalled++;
    if (stalled >= Math.ceil(this._peakActive / 2)) {
      this._outageActive = true;
      this.emit("provider_outage", { count: stalled, total: this._peakActive });
      this.emit("rotate_provider", { reason: "outage" as const, stallCount: stalled, totalGuards: this._peakActive });
    }
  }

  requestRotation(guard?: StallGuard): void {
    const stalled = guard && this._active.get(guard) ? 1 : 0;
    this.emit("rotate_provider", { reason: "exhausted" as const, stallCount: stalled, totalGuards: this._peakActive });
  }
}

export function buildStallResumePrompt(salvaged: string | undefined, fallback = "Continue. Complete the task."): string {
  return salvaged
    ? `Continue from where you left off. Here is what was already written:\n\n${salvaged.slice(0, 4000)}`
    : fallback;
}

export interface RunWithStallRotationOpts {
  run: (isResume: boolean, prompt: string, env: Record<string, string> | undefined) => Promise<void>;
  initialPrompt: string;
  initialIsResume: boolean;
  initialEnv: Record<string, string> | undefined;
  resolveFallbackEnv: () => Record<string, string> | undefined;
  log: (text: string) => void;
  defaultResumePrompt?: string;
  isAborted?: () => boolean;
  maxRetries?: number;
}

export async function runWithStallRotation(opts: RunWithStallRotationOpts): Promise<void> {
  let prompt = opts.initialPrompt;
  let isResume = opts.initialIsResume;
  let env = opts.initialEnv;
  let attempt = 0;
  const maxRetries = opts.maxRetries ?? 2;
  const monitor = StallMonitor.instance;

  while (true) {
    try {
      await opts.run(isResume, prompt, env);
      return;
    } catch (err) {
      if (!isStallError(err) || opts.isAborted?.()) throw err;
      const stall = err;
      const elapsedS = Math.round(stall.elapsedMs / 1000);

      if (monitor.outageActive) {
        env = opts.resolveFallbackEnv();
        opts.log(`Provider outage — rotating to fallback (stall at ${elapsedS}s)`);
        prompt = buildStallResumePrompt(stall.salvagedText, opts.defaultResumePrompt);
        isResume = true;
        continue;
      }
      if (attempt < maxRetries) {
        attempt++;
        const backoffMs = Math.min(30_000, 2000 * 4 ** (attempt - 1)) * (0.5 + Math.random());
        opts.log(`Stall at ${elapsedS}s — retry ${attempt}/${maxRetries} in ${Math.round(backoffMs / 1000)}s`);
        await new Promise(r => setTimeout(r, backoffMs));
        prompt = buildStallResumePrompt(stall.salvagedText, opts.defaultResumePrompt);
        isResume = true;
        monitor.emit("retry", { attempt, maxAttempts: maxRetries, elapsed: stall.elapsedMs });
        continue;
      }
      const fallback = opts.resolveFallbackEnv();
      if (fallback && env !== fallback) {
        monitor.requestRotation();
        env = fallback;
        opts.log(`Stall retries exhausted — rotating to fallback provider`);
        prompt = buildStallResumePrompt(stall.salvagedText, opts.defaultResumePrompt);
        isResume = true;
        attempt = 0;
        continue;
      }
      throw err;
    }
  }
}
