// Framework-agnostic UI state pub/sub.
//
// The Ink tree subscribes via `useSyncExternalStore` while RunDisplay pushes
// mutations through `patch()`. Keeping this React-free means the store can be
// unit-tested and any renderer (Ink, classic, tests) can sit on top of it.

import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
import type {
  AskState,
  LiveConfig,
  RunInfo,
  SteeringContext,
  SteeringEvent,
} from "./types.js";

export type Phase = "run" | "steering";
export type InputMode = "none" | "steer" | "ask" | "settings";

export interface DebriefEntry { label: string; text: string; time: number }

export interface UiState {
  runInfo: RunInfo;
  liveConfig?: LiveConfig;
  phase: Phase;

  // Run-phase live data
  swarm?: Swarm;
  selectedAgentId?: number;

  // Steering-phase live data
  rlGetter?: RLGetter;
  steeringContext?: SteeringContext;
  steeringStatusLine: string;
  steeringStartedAt: number;
  steeringEvents: SteeringEvent[];

  // Overlays
  ask?: AskState;
  askBusy: boolean;
  askTempFileAvailable: boolean;
  debrief?: { text: string; label?: string };
  debriefHistory: DebriefEntry[];

  // Input
  input: { mode: InputMode; buffer: string; settingsField: number };

  // Host capability flags (the footer mapper reads these)
  hasOnAsk: boolean;
  hasOnSteer: boolean;

  // 1Hz tick so elapsed counters never look frozen.
  tick: number;
}

type Listener = () => void;

export class UiStore {
  private state: UiState;
  private listeners = new Set<Listener>();

  constructor(initial: UiState) {
    this.state = initial;
  }

  get = (): UiState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  patch = (patch: Partial<UiState>): void => {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  };

  mutate = (fn: (s: UiState) => UiState): void => {
    this.state = fn(this.state);
    for (const l of this.listeners) l();
  };
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
}

export function makeInitialState(runInfo: RunInfo, liveConfig: LiveConfig | undefined, flags: { hasOnSteer: boolean; hasOnAsk: boolean }): UiState {
  return {
    runInfo,
    liveConfig,
    phase: "run",
    steeringStatusLine: "Assessing...",
    steeringStartedAt: 0,
    steeringEvents: [],
    askBusy: false,
    askTempFileAvailable: false,
    debriefHistory: [],
    input: { mode: "none", buffer: "", settingsField: 0 },
    hasOnAsk: flags.hasOnAsk,
    hasOnSteer: flags.hasOnSteer,
    tick: 0,
  };
}
