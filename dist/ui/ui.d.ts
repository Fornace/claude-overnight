import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
import type { AskState, LiveConfig, RunInfo, SteeringContext } from "./types.js";
export type { AskState, LiveConfig, RunInfo, SteeringContext, SteeringEvent } from "./types.js";
export declare class RunDisplay {
    readonly runInfo: RunInfo;
    private readonly store;
    private ink?;
    private started;
    private readonly isTTY;
    private askTempFile?;
    private plainInterval?;
    private lastSeq;
    private lastCompleted;
    private readonly onSteer?;
    private readonly onAsk?;
    private readonly onQuit?;
    constructor(runInfo: RunInfo, liveConfig?: LiveConfig, callbacks?: {
        onSteer?: (text: string) => void;
        onAsk?: (text: string) => void;
        onQuit?: () => void;
    });
    start(): void;
    pause(): void;
    resume(): void;
    private mountInk;
    stop(): void;
    setWave(swarm: Swarm): void;
    setSteering(rlGetter?: RLGetter, ctx?: SteeringContext): void;
    updateSteeringStatus(text: string): void;
    appendSteeringEvent(text: string): void;
    /** Backwards-compat alias. */
    updateText(text: string): void;
    selectAgent(id: number): void;
    clearSelectedAgent(): void;
    cycleSelectedAgent(direction?: 1 | -1): void;
    setAsk(state: AskState | undefined): void;
    setAskBusy(busy: boolean): void;
    clearAskState(): void;
    openAskTempFile(): void;
    private clearAskTempFile;
    setDebrief(text: string | undefined, label?: string): void;
    /** Force a re-render by bumping the tick — used after we mutate a swarm /
     *  liveConfig in-place and want the UI to reflect it immediately. */
    private nudge;
    private plainTick;
}
