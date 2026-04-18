import type { RLGetter } from "../../core/types.js";
import type { RunInfo, SteeringContext, SteeringEvent } from "../ui.js";
import type { InteractivePanel } from "../interactive-panel.js";
/** Everything the steering frame needs to render, produced fresh each tick. */
export interface SteeringViewData {
    /** The ephemeral ticker heartbeat — elapsed, tool count, cost, current reasoning snippet. */
    statusLine: string;
    /** Persistent scrollback of discrete events (tool uses, retries, nudges). */
    events: SteeringEvent[];
    /** Optional context read from disk at setSteering() time. */
    context?: SteeringContext;
    /** Wall-clock ms the steering phase started, for the live elapsed indicator. */
    startedAt?: number;
}
export declare function renderSteeringFrame(runInfo: RunInfo, data: SteeringViewData, showHotkeys: boolean, rlGetter?: RLGetter, maxRows?: number, panel?: InteractivePanel): string;
