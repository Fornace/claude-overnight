import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
import { InteractivePanel } from "./interactive-panel.js";
import type { AskState, LiveConfig, RunInfo, SteeringContext } from "./types.js";
import { type KeyboardHost } from "./keyboard.js";
export type { AskState, LiveConfig, RunInfo, SteeringContext, SteeringEvent } from "./types.js";
export declare class RunDisplay implements KeyboardHost {
    readonly runInfo: RunInfo;
    readonly panel: InteractivePanel;
    private _swarm?;
    private _liveConfig?;
    private steeringActive;
    private steeringStatusLine;
    private steeringStartedAt;
    private steeringEvents;
    private steeringContext?;
    private rlGetter?;
    private interval?;
    private keyHandler?;
    private started;
    private readonly isTTY;
    private lastSeq;
    private lastCompleted;
    private lastFrame;
    private readonly inputState;
    private _selectedAgentId?;
    private readonly navState;
    private _askState?;
    private _askBusy;
    private askTempFile?;
    private readonly onSteer?;
    private readonly onAsk?;
    constructor(runInfo: RunInfo, liveConfig?: LiveConfig, callbacks?: {
        onSteer?: (text: string) => void;
        onAsk?: (text: string) => void;
    });
    get swarm(): Swarm | undefined;
    get liveConfig(): LiveConfig | undefined;
    get selectedAgentId(): number | undefined;
    get askState(): AskState | undefined;
    get askBusy(): boolean;
    get hasOnSteer(): boolean;
    get hasOnAsk(): boolean;
    get hasAskTempFile(): boolean;
    getSelectedAgentId(): number | undefined;
    /** Cycle the selected agent detail to the next running agent (or first running if none selected). */
    cycleSelectedAgent(): void;
    /** Select a specific agent by ID for the detail panel. */
    selectAgent(id: number): void;
    /** Clear the agent detail panel. */
    clearSelectedAgent(): void;
    /** Replace the ask state. Called by run.ts as the side query streams and completes. */
    setAsk(state: AskState | undefined): void;
    setAskBusy(busy: boolean): void;
    /** Used by the keyboard pipeline to dismiss a completed ask without
     *  re-running the full setAsk teardown. */
    clearAskState(): void;
    openAskTempFile(): void;
    private clearAskTempFile;
    emitSteer(text: string): void;
    emitAsk(text: string): void;
    /** Set or clear the debrief text shown in the interactive panel. */
    setDebrief(text: string | undefined, label?: string): void;
    /** The view of phase state the navigator needs. Built fresh each call so it
     *  always reflects the latest swarm/steering snapshot. */
    private navContext;
    /** Arrow-key navigation dispatched by the keyboard pipeline. */
    navigate(direction: "up" | "down" | "left" | "right" | "enter"): boolean;
    /** Returns the unique highlight key for the currently focused row, used by renderer. */
    getHighlightKey(): string | undefined;
    start(): void;
    setWave(swarm: Swarm): void;
    setSteering(rlGetter?: RLGetter, ctx?: SteeringContext): void;
    /** Replace the single live status line (ticker heartbeat). */
    updateSteeringStatus(text: string): void;
    /** Append a discrete, persistent line to the steering scrollback. */
    appendSteeringEvent(text: string): void;
    /** Backwards-compat alias — treats input as the current status line. */
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
    private hasHotkeys;
    private setupHotkeys;
    private plainTick;
}
