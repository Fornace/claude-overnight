import type { Swarm } from "../swarm/swarm.js";
import type { AgentState } from "../core/types.js";
import type { SteeringContext, SteeringEvent } from "./types.js";
export interface NavState {
    focusSection: number;
    focusRow: number;
    scrollOffset: number;
}
export declare function newNavState(): NavState;
interface SectionDescriptor {
    title: string;
    rowCount: number;
    highlightKeyForRow: (row: number) => string | undefined;
}
/** Describes "where am I focused" inputs and outputs without coupling to
 *  RunDisplay internals. The navigator pulls phase data through this shape so
 *  the same code drives both the run and steering frames. */
export interface NavContext {
    swarm: Swarm | undefined;
    steeringActive: boolean;
    steeringEvents: SteeringEvent[];
    steeringContext: SteeringContext | undefined;
    selectedAgentId: number | undefined;
    selectAgent(id: number): void;
    clearSelectedAgent(): void;
}
/** Agents shown in the table = all running + the tail of finished. */
export declare function getVisibleAgents(swarm: Swarm | undefined): AgentState[];
/** Discover sections from the current phase for navigation boundaries. */
export declare function getSections(ctx: NavContext): SectionDescriptor[];
export declare function clampNavState(nav: NavState, sections: SectionDescriptor[]): void;
/** Move the focus cursor in `direction`. Returns true if anything changed.
 *  Side-effects on the agent selection happen via `ctx.selectAgent` /
 *  `ctx.clearSelectedAgent` so this module never mutates RunDisplay state
 *  directly. */
export declare function navigate(ctx: NavContext, nav: NavState, direction: "up" | "down" | "left" | "right" | "enter"): boolean;
/** Returns the unique highlight key for the currently focused row. */
export declare function highlightKey(ctx: NavContext, nav: NavState): string | undefined;
export {};
