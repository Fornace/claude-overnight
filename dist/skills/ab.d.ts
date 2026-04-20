import type { Task } from "../core/types.js";
export interface AbAssignment {
    skill: string;
    treatmentTaskIds: string[];
    controlTaskIds: string[];
    wave: number;
}
/**
 * Pick one skill for A/B testing and assign treatment/control arms.
 * Returns null if no eligible skill or insufficient agents.
 * Pure — reads DB and returns a decision without mutating anything.
 */
export declare function pickAbSkill(opts: {
    fingerprint: string;
    tasks: Task[];
    wave: number;
}): AbAssignment | null;
/**
 * Record A/B outcome after wave verification.
 * Writes skill_events rows for the trial outcome and cost attribution.
 */
export declare function recordAbOutcome(opts: {
    runId: string;
    wave: number;
    assignment: AbAssignment;
    treatmentScore: number;
    controlScore: number;
    treatmentFilesChanged: number;
    controlFilesChanged: number;
    treatmentCostUsd: number;
    controlCostUsd: number;
}): void;
