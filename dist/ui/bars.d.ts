import React from "react";
import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
/** Build the run-phase usage bar rows as chalk strings (Ink renders ANSI fine). */
export declare function UsageBars({ swarm, selectedAgentId }: {
    swarm: Swarm;
    selectedAgentId?: number;
}): React.ReactElement | null;
/** Steering-phase single-planner RL + Ctx bars. */
export declare function SteeringBars({ rl }: {
    rl: ReturnType<RLGetter>;
}): React.ReactElement | null;
