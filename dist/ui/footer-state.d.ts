import type { UiState } from "./store.js";
export type ActionId = "ask" | "steer" | "debrief" | "pause" | "settings" | "fallback" | "skip-rl" | "quit";
export type ActionState = "enabled" | "disabled:context" | "disabled:notready";
export interface Action {
    id: ActionId;
    key: string;
    label: string;
    slot: number;
    state: ActionState;
    reason?: string;
}
export declare function deriveFooter(state: UiState): Action[];
