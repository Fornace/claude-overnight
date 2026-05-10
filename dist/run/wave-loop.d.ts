import type { Task, MergeStrategy, BranchRecord, WaveSummary, RLGetter, RunState } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";
import { RunDisplay } from "../ui/ui.js";
import type { LiveConfig, SteeringContext } from "../ui/ui.js";
/** Mutable state shared between run.ts and the wave loop.
 *  Both modules read and write these fields directly — no getter/setter
 *  shim — so updates from either side are visible to the other. */
export interface WaveState {
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
    /** Planner's most recent "sessions to complete" estimate; used to size the
     *  budget-extension prompt when the run runs out of sessions. */
    lastEstimate: number | undefined;
    workerModel: string;
    plannerModel: string;
    fastModel: string | undefined;
    concurrency: number;
    usageCap: number | undefined;
    branches: BranchRecord[];
    waveHistory: WaveSummary[];
}
/** Read-only config + callbacks for the wave loop. */
export interface WaveLoopDeps {
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
    repoFingerprint: string;
    runId: string;
    allowSkillProposals: boolean;
    liveConfig: LiveConfig;
    display: RunDisplay;
    runSteering: () => Promise<boolean>;
    /** Verifier invoked between waves in no-flex mode. Mirrors runSteering. */
    runVerifier: () => Promise<boolean>;
    buildSteeringContext: () => SteeringContext;
    rlGetter: RLGetter;
    isStopping: () => boolean;
    syncRunInfo: () => void;
    runDebrief: (label: string) => void;
    onLibrarianResult?: (promoted: number, patched: number, quarantined: number, rejected: number) => void;
    /** Persist a RunState snapshot. Closes over runStateBase + state in run.ts
     *  so callers only supply the per-snapshot phase + (optional) task slice. */
    persistState: (phase: RunState["phase"], currentTasks?: Task[]) => void;
}
export declare function runWaveLoop(state: WaveState, deps: WaveLoopDeps): Promise<void>;
