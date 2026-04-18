import type { Task, MergeStrategy } from "../core/types.js";
export interface SwarmConfig {
    tasks: Task[];
    concurrency: number;
    cwd: string;
    model?: string;
    allowedTools?: string[];
    useWorktrees?: boolean;
    agentTimeoutMs?: number;
    maxRetries?: number;
    mergeStrategy?: MergeStrategy;
    usageCap?: number;
    allowExtraUsage?: boolean;
    extraUsageBudget?: number;
    baseCostUsd?: number;
    /** Per-task env overrides: given a model id, return the env to pass to `query()` (or undefined for Anthropic default). */
    envForModel?: (model?: string) => Record<string, string> | undefined;
    /** When true, the run uses cursor-composer-in-claude. The swarm will attempt to restart it if it crashes mid-run. */
    cursorProxy?: boolean;
}
/** Sent to an agent right after its main task completes, to take one more
 *  pass at trimming churn the agent introduced while exploring. */
export declare const SIMPLIFY_PROMPT = "You just finished your task. Review and simplify your changes.\n\nInvoke the `simplify` skill to review your changes for reuse, quality, and efficiency, then fix any issues found.";
/**
 * Proxied Cursor models ignore SDK `cwd` and use their own workspace
 * resolution. Inject `X-Cursor-Workspace` via ANTHROPIC_CUSTOM_HEADERS so the
 * proxy's per-request workspace override points at this agent's cwd.
 * Requires the proxy to run with `CURSOR_BRIDGE_WORKSPACE=/` (or a parent of
 * all worktree paths) so the header value passes the safety check.
 */
export declare function withCursorWorkspaceHeader(env: Record<string, string> | undefined, cwd: string): Record<string, string> | undefined;
