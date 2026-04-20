import type { Task, MergeStrategy, BranchRecord, WaveSummary, RLGetter, RunState } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";
import { RunDisplay } from "../ui/ui.js";
import type { LiveConfig, SteeringContext } from "../ui/ui.js";
/** Mutable state the wave loop reads and writes. */
export interface WaveLoopHost {
    currentSwarm: Swarm | undefined;
    remaining: number;
    currentTasks: Task[];
    waveNum: number;
    accCost: number;
    accIn: number;
    accOut: number;
    accCompleted: number;
    accFailed: number;
    accTools: number;
    peakWorkerCtxPct: number;
    peakWorkerCtxTokens: number;
    lastCapped: boolean;
    lastAborted: boolean;
    objectiveComplete: boolean;
    liveConfig: LiveConfig;
    workerModel: string;
    plannerModel: string;
    fastModel: string | undefined;
    concurrency: number;
    usageCap: number | undefined;
    branches: BranchRecord[];
    waveHistory: WaveSummary[];
    repoFingerprint: string;
    runId: string;
    allowSkillProposals: boolean;
}
/** Callbacks and read-only config for the wave loop. */
export interface WaveLoopCtx {
    cwd: string;
    runDir: string;
    agentTimeoutMs: number | undefined;
    envForModel: (model?: string) => Record<string, string> | undefined;
    beforeWaveCmds: string | string[] | undefined;
    afterWaveCmds: string | string[] | undefined;
    flex: boolean;
    useWorktrees: boolean;
    waveMerge: MergeStrategy;
    budget: number;
    cursorProxy: boolean;
    allowExtraUsage: boolean;
    extraUsageBudget: number;
    lastEstimate: number | undefined;
    display: RunDisplay;
    runSteering: () => Promise<boolean>;
    /** Verifier invoked between waves in no-flex mode. Mirrors runSteering's contract. */
    runVerifier?: () => Promise<boolean>;
    buildSteeringContext: () => SteeringContext;
    rlGetter: RLGetter;
    isStopping: () => boolean;
    syncRunInfo: () => void;
    renderSummary: (swarm: Swarm) => string;
    runDebrief: (label: string) => void;
    recordBranches: (agents: {
        branch?: string;
        task: {
            prompt: string;
        };
        status: string;
        filesChanged?: number;
        costUsd?: number;
    }[], mergeResults: {
        branch: string;
        ok: boolean;
    }[], currentWave?: number) => void;
    onLibrarianResult?: (promoted: number, patched: number, quarantined: number, rejected: number) => void;
    /** Builds a full RunState snapshot. Provided by run.ts so cwd, budget, branches,
     * provider ids, etc. are preserved — the wave loop used to rebuild a truncated
     * state that omitted cwd, which made saved runs invisible to `findIncompleteRuns`
     * (the cwd-equality filter dropped them). */
    buildRunState: (varying: {
        remaining: number;
        phase: RunState["phase"];
        currentTasks: Task[];
    }) => RunState;
}
export interface WaveLoopResult {
    runAnotherRound: boolean;
}
export declare function runWaveLoop(host: WaveLoopHost, ctx: WaveLoopCtx): Promise<WaveLoopResult>;
