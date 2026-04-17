import type { Task, RunState, RunConfigBase, WaveSummary } from "./types.js";
import type { ProviderConfig } from "./providers.js";
export interface RunConfig extends RunConfigBase {
    /** Tasks to execute. */
    tasks: Task[];
    /** High-level objective. */
    objective?: string;
    /** Custom provider for worker tasks (optional  -- Anthropic default when undefined). */
    workerProvider?: ProviderConfig;
    /** Custom provider for planner/steering calls (optional). */
    plannerProvider?: ProviderConfig;
    /** Custom provider for fast model tasks (optional). */
    fastProvider?: ProviderConfig;
    /** Per-agent timeout in ms. */
    agentTimeoutMs?: number;
    /** Working directory. */
    cwd: string;
    /** Allowlist of SDK tool names agents are permitted to use. */
    allowedTools?: string[];
    /** Shell command(s) to run in cwd before each wave starts (e.g. "pnpm run generate"). */
    beforeWave?: string | string[];
    /** Shell command(s) to run in cwd after each wave completes (e.g. "supabase db push"). */
    afterWave?: string | string[];
    /** Shell command(s) to run in cwd once after the entire run finishes (e.g. "vercel deploy"). */
    afterRun?: string | string[];
    /** Persisted run directory path. */
    runDir: string;
    /** Knowledge about the codebase from a pre-run thinking wave. */
    previousKnowledge: string;
    /** Whether this run is being resumed from a prior run.json. */
    resuming: boolean;
    /** State from the prior run (only set when resuming). */
    resumeState?: RunState;
    /** Sessions consumed by the pre-run thinking wave. */
    thinkingUsed: number;
    /** Cost of the pre-run thinking wave. */
    thinkingCost: number;
    /** Input tokens from the pre-run thinking wave. */
    thinkingIn: number;
    /** Output tokens from the pre-run thinking wave. */
    thinkingOut: number;
    /** Tool calls from the pre-run thinking wave. */
    thinkingTools: number;
    /** Wave summary from the pre-run thinking wave. */
    thinkingHistory?: WaveSummary;
    /** Unix timestamp (ms) when the run started. */
    runStartedAt: number;
    /** Original raw objective before the setup coach rewrote it. */
    coachedObjective?: string;
    /** Unix timestamp (ms) when the coach produced the accepted rewrite. */
    coachedAt?: number;
}
export declare function executeRun(cfg: RunConfig): Promise<void>;
