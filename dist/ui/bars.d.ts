import chalk from "chalk";
import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
/** Context-fill percentage and color function for a token count vs safe limit.
 *  Green under 50%, yellow past 50%, red past 80%. Exported so the run-phase
 *  frame can color an agent's detail row to match the header gauge. */
export declare function contextFillInfo(tokens: number, safe: number): {
    pct: number;
    color: typeof chalk;
};
export declare function renderUsageBars(out: string[], w: number, swarm: Swarm, selectedAgentId?: number): void;
export declare function renderSteeringUsageBar(out: string[], w: number, rl: ReturnType<RLGetter>): void;
