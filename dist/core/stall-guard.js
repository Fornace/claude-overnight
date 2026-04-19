import { EventEmitter } from "events";
import { onStreamEvent } from "./transcripts.js";
const DEFAULT_THRESHOLDS = {
    thinking: 30_000,
    action: 60_000,
    betweenTool: 45_000,
};
const TICK_MS = 5_000;
const PROVIDER_WINDOW_MS = 15_000;
/** ~300 tokens @ 4 chars/token. Below this, salvage isn't worth a resume prompt. */
const MIN_SALVAGE_CHARS = 1200;
export class StallError extends Error {
    elapsedMs;
    thresholdMs;
    activityType;
    salvagedText;
    constructor(elapsedMs, thresholdMs, activityType, salvagedText) {
        super(`StallGuard: ${activityType} stalled after ${Math.round(elapsedMs / 1000)}s (threshold ${Math.round(thresholdMs / 1000)}s)`);
        this.elapsedMs = elapsedMs;
        this.thresholdMs = thresholdMs;
        this.activityType = activityType;
        this.salvagedText = salvagedText;
        this.name = "StallError";
    }
}
export function isStallError(err) {
    return err instanceof StallError;
}
function classifyType(t) {
    if (t === "user" || t === "tool_result")
        return "betweenTool";
    if (t === "tool_use" || t === "tool_call")
        return "action";
    return "thinking";
}
export class StallGuard extends EventEmitter {
    thresholds;
    _sink;
    _abort;
    _interval;
    _stopped = false;
    _unsub;
    _salvagedText;
    _assembledDelta = "";
    _lastActivityType = "thinking";
    constructor(sink, abortController, thresholds = {}) {
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
    _onEvent(evt) {
        this._lastActivityType = classifyType(evt.type);
        const payload = evt.payload;
        if (payload?.type === "assistant" && typeof payload.delta === "string") {
            this._assembledDelta += payload.delta;
        }
    }
    _tick() {
        if (this._stopped || this._sink.finished)
            return;
        const kind = this._lastActivityType;
        const threshold = this.thresholds[kind];
        const elapsed = Date.now() - this._sink.lastByteAt;
        if (elapsed < threshold)
            return;
        if (this._assembledDelta.length >= MIN_SALVAGE_CHARS)
            this._salvagedText = this._assembledDelta;
        const error = new StallError(elapsed, threshold, kind, this._salvagedText);
        this.emit("stall", error);
        this._abort.abort(error);
        this.stop();
    }
    get salvagedText() { return this._salvagedText; }
    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        if (this._interval)
            clearInterval(this._interval);
        this._unsub?.();
        StallMonitor.instance.unregister(this);
    }
}
export class StallMonitor extends EventEmitter {
    static _instance;
    _active = new Map();
    _peakActive = 0;
    _outageActive = false;
    _fallbackProvider;
    static get instance() {
        if (!StallMonitor._instance)
            StallMonitor._instance = new StallMonitor();
        return StallMonitor._instance;
    }
    static reset() { StallMonitor._instance = undefined; }
    setFallbackProvider(fn) { this._fallbackProvider = fn; }
    getFallbackEnv(model) {
        return this._fallbackProvider?.(model);
    }
    get outageActive() { return this._outageActive; }
    resetOutage() { this._outageActive = false; }
    get activeCount() { return this._active.size; }
    register(guard) {
        guard.on("stall", () => this._onStall(guard));
        this._active.set(guard, 0);
        if (this._active.size > this._peakActive)
            this._peakActive = this._active.size;
    }
    unregister(guard) { this._active.delete(guard); }
    _onStall(guard) {
        this._active.set(guard, Date.now());
        if (this._outageActive || this._peakActive === 0)
            return;
        const now = Date.now();
        let stalled = 0;
        for (const t of this._active.values())
            if (t > 0 && now - t <= PROVIDER_WINDOW_MS)
                stalled++;
        if (stalled >= Math.ceil(this._peakActive / 2)) {
            this._outageActive = true;
            this.emit("provider_outage", { count: stalled, total: this._peakActive });
            this.emit("rotate_provider", { reason: "outage", stallCount: stalled, totalGuards: this._peakActive });
        }
    }
    requestRotation(guard) {
        const stalled = guard && this._active.get(guard) ? 1 : 0;
        this.emit("rotate_provider", { reason: "exhausted", stallCount: stalled, totalGuards: this._peakActive });
    }
}
export function buildStallResumePrompt(salvaged, fallback = "Continue. Complete the task.") {
    return salvaged
        ? `Continue from where you left off. Here is what was already written:\n\n${salvaged.slice(0, 4000)}`
        : fallback;
}
export async function runWithStallRotation(opts) {
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
        }
        catch (err) {
            if (!isStallError(err) || opts.isAborted?.())
                throw err;
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
