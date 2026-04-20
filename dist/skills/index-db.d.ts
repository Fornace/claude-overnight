import Database from "better-sqlite3";
/** Open (or create + migrate) the skills index. Idempotent. */
export declare function openSkillsDb(): Database.Database;
export interface SkillRow {
    name: string;
    repo_fingerprint: string;
    description: string;
    version: number;
    languages: string;
    toolsets: string;
    requires_tools: string;
    triggers: string;
    body_path: string;
    size_bytes: number;
    uses: number;
    wins: number;
    losses: number;
    cost_saved_usd: number;
    created_at: string;
    last_used_at: string | null;
    last_wave: number | null;
    quarantined: number;
    ab_eligible: number;
    ab_last_trial_run: string | null;
    kind: string;
}
/** Return candidates for a fingerprint that match the agent's available tools. */
export declare function queryCandidateL0(fp: string, ctx: {
    availableTools?: string[];
}): SkillRow[];
/** Return recipes for a fingerprint that match the agent's available tools. */
export declare function queryRecipeL0(fp: string, ctx: {
    availableTools?: string[];
}): SkillRow[];
/** Append a telemetry event. */
export declare function recordEvent(runId: string, wave: number, skill: string, event: string, value?: number, notes?: string): void;
/** Increment use counter and refresh last_used_at. */
export declare function incrementUse(skillName: string): void;
/** Return skills eligible for A/B testing for this fingerprint. */
export declare function queryAbEligibleSkills(fp: string): SkillRow[];
/** Mark a skill's last A/B trial timestamp. */
export declare function markAbTrial(skillName: string): void;
/** Reset the in-memory handle (useful for tests). */
export declare function resetDb(): void;
