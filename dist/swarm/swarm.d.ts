import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, AgentState, SwarmPhase, RateLimitWindow, AITurn } from "../core/types.js";
import type { MergeResult } from "./merge.js";
import { type SwarmConfig } from "./config.js";
import type { PendingTool } from "./message-handler.js";
export type { SwarmConfig };
export declare class Swarm {
    readonly agents: AgentState[];
    readonly logs: {
        time: number;
        agentId: number;
        text: string;
    }[];
    private readonly allLogs;
    /** @internal -- friend surface for swarm-message-handler. */
    readonly _agentTurns: Map<number, AITurn>;
    readonly startedAt: number;
    readonly total: number;
    completed: number;
    failed: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    phase: SwarmPhase;
    aborted: boolean;
    cappedOut: boolean;
    mergeResults: MergeResult[];
    /** Prior-wave orphan branches recovered during stale worktree cleanup. */
    staleRecovered: number;
    /** Prior-wave orphan branches discarded as unmergeable. */
    staleForceDeleted: number;
    rateLimitUtilization: number;
    rateLimitResetsAt?: number;
    rateLimitWindows: Map<string, RateLimitWindow>;
    rateLimitPaused: number;
    /** Wall-clock ms the global rate-limit wait started. Reset to undefined once nothing is blocked. */
    rateLimitBlockedSince?: number;
    isUsingOverage: boolean;
    overageCostUsd: number;
    /** @internal -- friend surface for swarm-message-handler. */
    rateLimitExplained: boolean;
    private rateLimitWakers;
    /** Live-adjustable concurrency target. Workers above this count exit on the next task boundary. */
    targetConcurrency: number;
    /** When true, dispatch is frozen  -- workers wait without starting new tasks. */
    paused: boolean;
    /** Wall-clock ms of the last sign of real progress (assistant msg, tool use, result). */
    lastProgressAt: number;
    /** 0 = normal, 1 = halved once, 2 = halved twice, 3 = long cooldown at c=1, 4 = aborted. */
    stallLevel: number;
    /** Last time the watchdog took an action; used to debounce escalations. */
    private stallActionAt;
    /** Live worker coroutine count (not agents). */
    private workerCount;
    /** Growable list of worker promises; run() awaits until empty. */
    private workerPromises;
    /** @internal -- friend surface for swarm-agent-run. */
    readonly queue: Task[];
    /** @internal -- friend surface for swarm-message-handler. */
    readonly config: SwarmConfig;
    /** @internal -- friend surface for swarm-agent-run. */
    nextId: number;
    /** @internal -- friend surface for swarm-agent-run. */
    worktreeBase?: string;
    /** @internal -- friend surface for swarm-agent-run. */
    readonly activeQueries: Set<Query>;
    private cleanedUp;
    /** @internal -- friend surface for swarm-message-handler. */
    readonly pendingTools: WeakMap<AgentState, PendingTool>;
    /** @internal -- friend surface for swarm-message-handler. */
    readonly ctxWarned: WeakSet<AgentState>;
    logFile?: string;
    model: string | undefined;
    usageCap: number | undefined;
    readonly allowExtraUsage: boolean;
    extraUsageBudget: number | undefined;
    readonly baseCostUsd: number;
    mergeBranch?: string;
    constructor(config: SwarmConfig);
    get active(): number;
    get blocked(): number;
    get pending(): number;
    /** Live-adjust concurrency. Shrinks by having excess workers exit on next task boundary; grows by spawning new workers. */
    setConcurrency(n: number): void;
    /** Freeze/resume dispatch without killing the run. Paused workers block at the top of their loop. */
    setPaused(b: boolean): void;
    /** Returns the rate-limit window currently holding the swarm back  -- rejected first, then highest utilization. */
    mostConstrainedWindow(): RateLimitWindow | undefined;
    /** @internal -- friend surface for swarm-agent-run. */
    windowTag(): string;
    /** Cancellable sleep used by rate-limit waits. `retryRateLimitNow()` wakes every pending sleeper.
     *  @internal -- friend surface for swarm-agent-run. */
    rateLimitSleep(ms: number): Promise<void>;
    /** Force-wake every rate-limit sleeper and clear the reset timestamp so the next attempt fires immediately. */
    retryRateLimitNow(): void;
    /** Live-adjust the overage spend cap. `undefined` = unlimited. If already over the new cap, stop dispatch. */
    setExtraUsageBudget(n: number | undefined): void;
    /** Live-adjust the worker model. Picked up by next agent dispatch. */
    setModel(m: string): void;
    run(): Promise<void>;
    abort(): void;
    /** Re-queue all errored agents' tasks for retry within this wave. */
    requeueFailed(): number;
    logSequence: number;
    log(agentId: number, text: string): void;
    cleanup(): void;
    private worker;
    /** Mark real progress  -- resets stall state. Called on any assistant/tool/result message.
     *  @internal -- friend surface for swarm-message-handler. */
    markProgress(): void;
    /**
     * Stall watchdog. Called each time a worker finishes a rate-limit wait. Escalates when
     * the whole swarm has been stuck with no progress for a while:
     *   L1 @ 5m → halve concurrency
     *   L2 @ 10m → halve again
     *   L3 @ 15m+ at c=1 → force a 10-minute cooldown instead of hammering every 60s
     *   L4 @ 30m → abort the run so it can be resumed later without burning the budget
     */
    /** @internal -- friend surface for swarm-agent-run. */
    checkStall(): void;
    private capForOverage;
    private throttle;
    /** Returns the nearest future resetsAt from any rejected window, or undefined. */
    private windowRejectedReset;
    private runAgent;
    /** @internal -- friend surface for swarm-agent-run. */
    agentSummary(agent: AgentState): string;
}
