import type { Swarm } from "./swarm.js";
import type { RateLimitWindow } from "./types.js";
import type { RunInfo, SteeringContext, SteeringEvent } from "./ui.js";
export interface Section {
    title: string;
    rows: string[];
    scrollable?: boolean;
    highlightKey?: string;
}
export interface ContentRenderer {
    /** Returns an array of sections to render in the content area */
    sections(): Section[];
}
export declare function truncate(s: string, max: number): string;
export declare function fmtTokens(n: number): string;
export declare function fmtDur(ms: number): string;
export declare function renderUnifiedFrame(params: {
    model?: string;
    phase: string;
    barPct: number;
    barLabel: string;
    active?: number;
    blocked?: number;
    queued?: number;
    startedAt: number;
    totalIn: number;
    totalOut: number;
    totalCost: number;
    waveNum: number;
    sessionsUsed: number;
    sessionsBudget: number;
    remaining: number;
    usageBarRender?: (out: string[], w: number) => void;
    content: ContentRenderer;
    hotkeyRow?: string;
    extraFooterRows?: string[];
    maxRows?: number;
}): string;
type RLGetter = () => {
    utilization: number;
    isUsingOverage: boolean;
    windows: Map<string, RateLimitWindow>;
    resetsAt?: number;
};
export declare function renderFrame(swarm: Swarm, showHotkeys: boolean, runInfo?: RunInfo, selectedAgentId?: number, maxRows?: number): string;
export interface SteeringViewData {
    /** The ephemeral ticker heartbeat  -- elapsed, tool count, cost, current reasoning snippet. */
    statusLine: string;
    /** Persistent scrollback of discrete events (tool uses, retries, nudges). */
    events: SteeringEvent[];
    /** Optional context read from disk at setSteering() time. */
    context?: SteeringContext;
}
export declare function renderSteeringFrame(runInfo: RunInfo, data: SteeringViewData, showHotkeys: boolean, rlGetter?: RLGetter, maxRows?: number): string;
export declare function renderSummary(swarm: Swarm): string;
export {};
