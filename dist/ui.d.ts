import type { Swarm } from "./swarm.js";
import type { RateLimitWindow, WaveSummary } from "./types.js";
/** Short-lived context the steering view renders around its live log. */
export interface SteeringContext {
    objective?: string;
    status?: string;
    lastWave?: WaveSummary;
}
/** One scrollback line in the steering event log. */
export interface SteeringEvent {
    time: number;
    text: string;
}
/** Cumulative run-level stats  -- mutable, updated between phases. */
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
    /** Overage spend cap ($)  -- undefined = unlimited. Synced from the [e] hotkey. */
    extraUsageBudget?: number;
}
/** State of an in-flight or recently-completed ask side query. */
export interface AskState {
    question: string;
    answer: string;
    streaming: boolean;
    error?: string;
}
type RLGetter = () => {
    utilization: number;
    isUsingOverage: boolean;
    windows: Map<string, RateLimitWindow>;
    resetsAt?: number;
};
export declare class RunDisplay {
    readonly runInfo: RunInfo;
    private liveConfig?;
    private swarm?;
    private steeringActive;
    private steeringStatusLine;
    private steeringEvents;
    private steeringContext?;
    private rlGetter?;
    private interval?;
    private keyHandler?;
    private inputMode;
    private inputSegs;
    private started;
    private readonly isTTY;
    private lastSeq;
    private lastCompleted;
    private askState?;
    private askBusy;
    private askTempFile?;
    /** ID of the agent whose detail panel is open; undefined = no detail shown. */
    private selectedAgentId?;
    private navState;
    private onSteer?;
    private onAsk?;
    constructor(runInfo: RunInfo, liveConfig?: LiveConfig, callbacks?: {
        onSteer?: (text: string) => void;
        onAsk?: (text: string) => void;
    });
    /** Replace the ask state. Called by run.ts as the side query streams and completes. */
    setAsk(state: AskState | undefined): void;
    /** Signal to the UI whether an ask is in progress (prevents duplicate firings). */
    setAskBusy(busy: boolean): void;
    /** Cycle the selected agent detail to the next running agent (or first running if none selected). */
    cycleSelectedAgent(): void;
    /** Select a specific agent by ID for the detail panel. */
    selectAgent(id: number): void;
    /** Clear the agent detail panel. */
    clearSelectedAgent(): void;
    /** Arrow-key navigation dispatched by the demux in handleTyped(). */
    navigate(direction: "up" | "down" | "left" | "right" | "enter"): boolean;
    /** Get the agents visible in the table (running + last N finished). */
    private getVisibleAgents;
    /** Discover sections from the current render state for navigation boundaries. */
    private getSections;
    private clampNavState;
    /** Returns the unique highlight key for the currently focused row, used by renderer. */
    getHighlightKey(): string | undefined;
    private clearAskTempFile;
    /** Get the currently selected agent's ID for rendering. */
    getSelectedAgentId(): number | undefined;
    start(): void;
    setWave(swarm: Swarm): void;
    setSteering(rlGetter?: RLGetter, ctx?: SteeringContext): void;
    /** Replace the single live status line (ticker heartbeat). */
    updateSteeringStatus(text: string): void;
    /** Append a discrete, persistent line to the steering scrollback. */
    appendSteeringEvent(text: string): void;
    /** Backwards-compat alias  -- treats input as the current status line. */
    updateText(text: string): void;
    pause(): void;
    resume(): void;
    stop(): void;
    private resumeInterval;
    /** Write the full frame to stdout, clamped to terminal height.
     *  Layout: header + content (elastic) + footer + input/ask (fixed).
     *  The content area shrinks so input prompts are never clipped. */
    private flush;
    private render;
    private renderInputPrompt;
    private renderAskPanel;
    private hasHotkeys;
    private setupHotkeys;
    /** Handle a pasted block. Returns true if the frame needs a redraw. */
    private handlePaste;
    /** Handle a typed (non-pasted) chunk. Returns true if the frame needs a redraw.
     *
     * Demux pipeline  -- routes escape sequences and modifiers BEFORE hotkey matching:
     *   Raw stdin chunk → splitPaste
     *     ├─ paste → handlePaste
     *     └─ typed → demux
     *          1. ESC + [A/B/C/D  → navigate; other CSI → swallow
     *          2. ESC + non-[     → Alt/Option+key → swallow
     *          3. ESC alone       → cancel input / close detail / dismiss panel
     *          4. numeric input   → digits, Enter, Backspace
     *          5. text input      → printable chars, Enter, Backspace, ESC (with lookahead)
     *          6. hotkey mode     → b, t, c, e, p, s, q, ?, d, 0-9
     */
    private handleTyped;
    private plainTick;
}
export {};
