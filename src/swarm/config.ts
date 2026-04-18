// Inputs and constants the Swarm consumes — kept separate from the class
// itself so callers can build a config without dragging in the worker loop.

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
export const SIMPLIFY_PROMPT = `You just finished your task. Review and simplify your changes.

Invoke the \`simplify\` skill to review your changes for reuse, quality, and efficiency, then fix any issues found.`;

/**
 * Proxied Cursor models ignore SDK `cwd` and use their own workspace
 * resolution. Inject `X-Cursor-Workspace` via ANTHROPIC_CUSTOM_HEADERS so the
 * proxy's per-request workspace override points at this agent's cwd.
 * Requires the proxy to run with `CURSOR_BRIDGE_WORKSPACE=/` (or a parent of
 * all worktree paths) so the header value passes the safety check.
 */
export function withCursorWorkspaceHeader(
  env: Record<string, string> | undefined,
  cwd: string,
): Record<string, string> | undefined {
  if (!env) return undefined;
  // Detect "this env routes to a cursor-composer proxy" rather than matching a
  // literal URL — per-project port resolution means the proxy frequently runs
  // on e.g. :62717 instead of the default :8765, and a strict equality check
  // would silently skip header injection on those runs. Without the header,
  // Cursor ignores the SDK cwd, never invokes Skills, and emits zero tool_use
  // blocks — agents sit idle for minutes, costing the whole run.
  const isCursorEnv = !!(env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN || env.CURSOR_BRIDGE_MODE);
  if (!isCursorEnv) return env;
  const hdr = `X-Cursor-Workspace: ${cwd}`;
  const existing = env.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return {
    ...env,
    ANTHROPIC_CUSTOM_HEADERS: existing
      ? `${existing}\n${hdr}`
      : hdr,
  };
}

/** Default per-agent inactivity watchdog (see `agent-run` race with SDK `query`). */
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Per-agent watchdog timeout in ms. Override with `AGENT_TIMEOUT_MS` (integer).
 * Explicit `SwarmConfig.agentTimeoutMs` still wins at call sites that pass it.
 */
export function getAgentTimeout(): number {
  const raw = process.env.AGENT_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_AGENT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AGENT_TIMEOUT_MS;
  return n;
}
