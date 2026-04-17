/** A single unit of work assigned to one agent. */
export interface Task {
  /** Unique identifier for this task. */
  id: string;
  /** The natural-language instruction sent to the agent. */
  prompt: string;
  /** Working directory the agent operates in; defaults to the swarm's cwd. */
  cwd?: string;
  /** Model override for this specific task (resolved via provider config). */
  model?: string;
  /** When true, skip worktree isolation  -- run in the real project directory with env files, dependencies, and local config. */
  noWorktree?: boolean;
  /** SDK session ID to resume from (set when task was paused mid-turn). */
  resumeSessionId?: string;
  /** Working directory preserved from a previous run (worktree dir for paused-and-resumed tasks). */
  agentCwd?: string;
  /** The kind of work: "execute" modifies files, others are read-only/analysis. Defaults to "execute". */
  type?: string;
  /** Shell command that must exit 0 for the task to be considered done. Runs in cwd after merge. Failed postconditions trigger the same retry path as filesChanged=0. */
  postcondition?: string;
}

/** Schema for a JSON task file that defines a batch of work for the swarm. */
export interface TaskFile {
  /** High-level objective for multi-wave steering (required when flexiblePlan is true). */
  objective?: string;
  /** Max number of agents running in parallel. */
  concurrency?: number;
  /** Default working directory for all tasks. */
  cwd?: string;
  /** Default Claude model for all tasks. */
  model?: string;
  /** How the SDK handles permission prompts for dangerous operations. */
  permissionMode?: PermMode;
  /** Allowlist of SDK tool names agents are permitted to use. */
  allowedTools?: string[];
  /** Shell command(s) to run in cwd before each wave starts (e.g. "pnpm run generate"). */
  beforeWave?: string | string[];
  /** Shell command(s) to run in cwd after each wave completes (e.g. "supabase db push"). */
  afterWave?: string | string[];
  /** Shell command(s) to run in cwd once after the entire run finishes (e.g. "vercel deploy"). */
  afterRun?: string | string[];
  /** Merge strategy: "yolo" merges into current branch, "branch" creates a new branch. */
  mergeStrategy?: MergeStrategy;
  /** Stop dispatching new tasks when rate-limit utilization reaches this percentage (0-100). */
  usageCap?: number;
  /** Enable adaptive multi-wave planning: after each wave, a steering agent reads the codebase and plans the next wave. Default true in interactive mode. */
  flexiblePlan?: boolean;
  /** Tasks to execute  -- either plain prompt strings or objects with per-task overrides. */
  tasks: (string | { prompt: string; cwd?: string; model?: string })[];
}

/** Lifecycle status of a single agent. */
export type AgentStatus = "pending" | "running" | "paused" | "done" | "error";

/** Live mutable state for one agent, used by the UI and orchestrator. */
export interface AgentState {
  /** Sequential agent index (0-based), used for display and log correlation. */
  id: number;
  /** The task this agent is executing. */
  task: Task;
  /** Current lifecycle status of this agent. */
  status: AgentStatus;
  /** Name of the SDK tool the agent is currently invoking (e.g. "Edit", "Bash"); cleared when the tool finishes. */
  currentTool?: string;
  /** Last short text snippet from the agent's streaming response, used as a status line when no tool is active. */
  lastText?: string;
  /** Unix timestamp (ms) when the agent started executing. */
  startedAt?: number;
  /** Unix timestamp (ms) when the agent finished or errored. */
  finishedAt?: number;
  /** Error message if the agent failed. */
  error?: string;
  /** Cumulative number of tool calls the agent has made. */
  toolCalls: number;
  /** Estimated cost in USD for this agent's API usage. */
  costUsd?: number;
  /** Git branch name when using worktree isolation. */
  branch?: string;
  /** Commit the worktree branch was created from  -- the baseline for measuring filesChanged. */
  baseRef?: string;
  /** Number of files changed by the agent (from git diff). */
  filesChanged?: number;
  /** Unix timestamp (ms) when this agent entered a rate-limit wait inside its retry loop. Cleared when work resumes. */
  blockedAt?: number;
  /** Total input tokens (input + cache_read + cache_creation) from the most recent turn — a proxy for current context-window occupancy. */
  contextTokens?: number;
  /** Highest turn total ever seen for this agent (across all turns, including compaction peaks). */
  peakContextTokens?: number;
  /** Resolved model this agent is running (task override or swarm default). */
  model?: string;
}

/** A timestamped log line from an agent's execution. */
export interface LogEntry {
  /** Unix timestamp (ms) when the entry was recorded. */
  time: number;
  /** ID of the agent that produced this log entry. */
  agentId: number;
  /** The log message content. */
  text: string;
}

/**
 * Which phase of the run an AI turn belongs to.
 */
export type AITurnPhase =
  | "coach" | "identify-themes" | "thinking-wave" | "plan"
  | "orchestrate" | "plan-refine" | "plan-chat" | "ask" | "debrief"
  | "steer" | "swarm" | "review-wave" | "review-run" | "health-check";

/** Lifecycle status of one AI turn. */
export type AITurnStatus = "pending" | "running" | "done" | "error" | "stopped";

/** One AI-powered invocation (coach query, planner call, swarm agent, etc.). */
export interface AITurn {
  /** Unique ID (e.g. "coach-0", "steer-2", "swarm-a7"). */
  id: string;
  /** High-level phase this turn belongs to. */
  phase: AITurnPhase;
  /** Human-readable label shown in the context meter. */
  label: string;
  /** Model used for this turn. */
  model?: string;
  /** Tokens consumed (input + cache_read + cache_creation) in the last/only turn. */
  contextTokens?: number;
  /** Peak context tokens seen during this turn's lifetime. */
  peakContextTokens?: number;
  /** Estimated cost in USD. */
  costUsd?: number;
  /** Current lifecycle status. */
  status: AITurnStatus;
  /** When this turn started (ms). */
  startedAt?: number;
  /** When this turn finished (ms). */
  finishedAt?: number;
  /** Error message if failed. */
  error?: string;
}

/**
 * How the SDK handles permission prompts for potentially dangerous operations.
 * - "auto": SDK decides what's safe  -- accepts low-risk tools, rejects high-risk ones.
 * - "bypassPermissions": Skip all permission prompts (dangerous  -- agents can run anything).
 * - "default": Prompt the user for each dangerous operation.
 */
export type PermMode = "auto" | "bypassPermissions" | "default";

/**
 * Current phase of the swarm lifecycle.
 * - "planning": An LLM is decomposing an objective into individual tasks.
 * - "running": Agents are actively executing their assigned tasks.
 * - "merging": All agents finished; worktree branches are being merged back.
 * - "done": Swarm has completed all work.
 */
export type SwarmPhase = "planning" | "running" | "merging" | "done";

/**
 * How worktree branches are merged after agents complete.
 * - "yolo": Merge directly into the current branch.
 * - "branch": Create a new branch, merge everything there (main untouched).
 */
export type MergeStrategy = "yolo" | "branch";

/** Tracks a git branch created by an agent. */
export interface BranchRecord {
  branch: string;
  taskPrompt: string;
  status: "merged" | "unmerged" | "failed" | "merge-failed";
  filesChanged: number;
  costUsd: number;
}

/** Per-window rate limit snapshot (matches SDK rateLimitType). */
export interface RateLimitWindow {
  type: string; // "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage"
  utilization: number;
  status: string;
  resetsAt?: number;
}

export const RATE_LIMIT_WINDOW_SHORT: Record<string, string> = {
  five_hour: "5h", seven_day: "7d", seven_day_opus: "7d opus",
  seven_day_sonnet: "7d sonnet", overage: "extra",
};

/** Thrown when a query goes silent  -- carries session ID for interrupt+resume. */
export class NudgeError extends Error {
  constructor(public sessionId: string | undefined, silentMs: number) {
    super(`Silent for ${Math.round(silentMs / 1000)}s  -- nudging`);
    this.name = "NudgeError";
  }
}

/** Summary of one completed wave, used by steering to decide next actions. */
export interface WaveSummary {
  wave: number;
  tasks: { prompt: string; status: string; type?: string; filesChanged?: number; error?: string }[];
}

/** Result from the steering function. */
export interface SteerResult {
  done: boolean;
  tasks: Task[];
  reasoning: string;
  goalUpdate?: string;
  statusUpdate?: string;
  estimatedSessionsRemaining?: number;
}

/** RunMemory accumulates run designs, reflections, verifications, milestones, status, goal, and previous runs. */
export interface RunMemory {
  designs: string;
  reflections: string;
  verifications: string;
  milestones: string;
  status: string;
  goal: string;
  previousRuns?: string;
  /** Pending user directives from the steer inbox, consumed by the next successful steering call. */
  userGuidance?: string;
}

/** Mutable subset of RunConfigBase — settings that can be changed at any point, including mid-run. */
export interface MutableRunSettings {
  workerModel: string;
  plannerModel: string;
  fastModel?: string;
  workerProviderId?: string;
  plannerProviderId?: string;
  fastProviderId?: string;
  concurrency: number;
  usageCap?: number;
  allowExtraUsage: boolean;
  extraUsageBudget?: number;
  permissionMode: PermMode;
  beforeWave?: string | string[];
  afterWave?: string | string[];
  afterRun?: string | string[];
}

/** Shared configuration for a run  -- both live (RunConfig) and persisted (RunState). */
export interface RunConfigBase {
  /** Total session budget. */
  budget: number;
  /** Model for worker/agent tasks. */
  workerModel: string;
  /** Model for planner/steering calls. */
  plannerModel: string;
  /** Optional fast model for quick tasks that will be verified. */
  fastModel?: string;
  /** Custom provider id for worker tasks. */
  workerProviderId?: string;
  /** Custom provider id for planner/steering calls. */
  plannerProviderId?: string;
  /** Custom provider id for fast model tasks. */
  fastProviderId?: string;
  /** Max parallel agents. */
  concurrency: number;
  /** Permission mode for SDK tool calls. */
  permissionMode: PermMode;
  /** Stop dispatching when rate-limit utilization reaches this %. */
  usageCap?: number;
  /** Whether extra/overage usage is allowed. */
  allowExtraUsage: boolean;
  /** Max $ for extra usage. */
  extraUsageBudget?: number;
  /** Enable adaptive multi-wave planning. */
  flex: boolean;
  /** Use git worktree isolation for agents. */
  useWorktrees: boolean;
  /** Shell command(s) to run in cwd before each wave starts (e.g. "pnpm run generate"). */
  beforeWave?: string | string[];
  /** Shell command(s) to run in cwd after each wave completes (e.g. "supabase db push"). */
  afterWave?: string | string[];
  /** Shell command(s) to run in cwd once after the entire run finishes (e.g. "vercel deploy"). */
  afterRun?: string | string[];
  /** How worktree branches are merged. */
  mergeStrategy: MergeStrategy;
}

/** Persisted run state for crash recovery and resume. */
export interface RunState extends RunConfigBase {
  /** Unique run identifier. */
  id: string;
  /** Run objective/goal. */
  objective: string;
  /** Remaining sessions. */
  remaining: number;
  /** Current wave number. */
  waveNum: number;
  /** Tasks for the current/next wave. */
  currentTasks: Task[];
  /** Accumulated cost in USD. */
  accCost: number;
  /** Accumulated completed sessions. */
  accCompleted: number;
  /** Accumulated failed sessions. */
  accFailed: number;
  /** Accumulated input tokens. */
  accIn?: number;
  /** Accumulated output tokens. */
  accOut?: number;
  /** Accumulated tool calls. */
  accTools?: number;
  /** Tracked git branches. */
  branches: BranchRecord[];
  /** Current lifecycle phase. */
  phase: "planning" | "steering" | "capped" | "done" | "stopped";
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** Working directory for the run. */
  cwd: string;
  /** Original raw objective the user typed, before the setup coach rewrote it. Optional — only present when the coach ran and was accepted. */
  coachedObjective?: string;
  /** Unix timestamp (ms) when the coach produced the accepted rewrite. */
  coachedAt?: number;
}

/** Function that returns a rate-limit snapshot with optional context token info. */
export type RLGetter = () => { utilization: number; isUsingOverage: boolean; windows: Map<string, RateLimitWindow>; resetsAt?: number; contextTokens?: number; model?: string };

/** Pick a short, human-readable target for a tool invocation (Read/Grep/Bash/...). */
export function extractToolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const p = input.path ?? input.file_path ?? input.pattern;
  if (typeof p === "string" && p) return p;
  if (typeof input.command === "string" && input.command) {
    return input.command.split(" ").slice(0, 3).join(" ");
  }
  return "";
}

/** Sum input + cache read + cache creation tokens from a usage object. */
export function sumUsageTokens(u: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
