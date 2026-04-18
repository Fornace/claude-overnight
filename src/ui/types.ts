// Public types shared between the live display, the renderer, and the run
// loop. They live in their own file so the renderer can import them without
// pulling in the heavier RunDisplay class.

import type { WaveSummary, PermMode } from "../core/types.js";

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
  /** Overage spend cap ($) — undefined = unlimited. Synced from the [s] hotkey. */
  extraUsageBudget?: number;
  /** Worker model for agent tasks. Changed mid-run, picked up by next wave/agent dispatch. */
  workerModel?: string;
  /** Planner/steering model. Changed mid-run, picked up by next steer/planner call. */
  plannerModel?: string;
  /** Fast model for quick verification tasks. */
  fastModel?: string;
  /** SDK permission mode. Changed mid-run, picked up by next agent dispatch. */
  permissionMode?: PermMode;
}

/** State of an in-flight or recently-completed ask side query. */
export interface AskState {
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
}
