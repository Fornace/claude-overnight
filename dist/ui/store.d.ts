import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
import type { AskState, LiveConfig, RunInfo, SteeringContext, SteeringEvent } from "./types.js";
export type Phase = "run" | "steering";
export type InputMode = "none" | "steer" | "ask" | "settings";
export interface DebriefEntry {
    label: string;
    text: string;
    time: number;
}
export interface UiState {
    runInfo: RunInfo;
    liveConfig?: LiveConfig;
    phase: Phase;
    swarm?: Swarm;
    selectedAgentId?: number;
    rlGetter?: RLGetter;
    steeringContext?: SteeringContext;
    steeringStatusLine: string;
    steeringStartedAt: number;
    steeringEvents: SteeringEvent[];
    ask?: AskState;
    askBusy: boolean;
    askTempFileAvailable: boolean;
    debrief?: {
        text: string;
        label?: string;
    };
    debriefHistory: DebriefEntry[];
    input: {
        mode: InputMode;
        buffer: string;
        settingsField: number;
    };
    hasOnAsk: boolean;
    hasOnSteer: boolean;
    tick: number;
}
type Listener = () => void;
export declare class UiStore {
    private state;
    private listeners;
    constructor(initial: UiState);
    get: () => UiState;
    subscribe: (l: Listener) => (() => void);
    patch: (patch: Partial<UiState>) => void;
    mutate: (fn: (s: UiState) => UiState) => void;
}
/** Callbacks the Ink input layer invokes back into the host (RunDisplay). */
export interface HostCallbacks {
    onSteer(text: string): void;
    onAsk(text: string): void;
    clearAsk(): void;
    openAskTempFile(): void;
    cycleAgent(dir: 1 | -1): void;
    selectAgent(id: number): void;
    clearSelectedAgent(): void;
    settingsTick(): void;
    /** User requested a clean quit. Runner should set its stopping flag + abort the live swarm. */
    requestQuit(): void;
}
export declare function makeInitialState(runInfo: RunInfo, liveConfig: LiveConfig | undefined, flags: {
    hasOnSteer: boolean;
    hasOnAsk: boolean;
}): UiState;
export {};
