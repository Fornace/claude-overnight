import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { RLGetter } from "./types.js";
import type { RunInfo, SteeringContext, SteeringEvent } from "./ui.js";
import { InteractivePanel } from "./interactive-panel.js";
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
/** Single-frame character of a spinner. Exported so any caller can prefix its
 *  own line with a consistent animation without importing SPINNER directly. */
export declare function spinnerFrame(kind?: "line" | "dots"): string;
/** Reusable indicator for any in-flight wait. Always shows animation + elapsed
 *  time so no phase ever appears frozen. `eta` (future timestamp) adds a
 *  countdown; `hint` appends a short secondary label.
 *
 *  style:
 *    - "thinking" (cyan): planner/AI reasoning
 *    - "wait"     (magenta): rate-limit / cooldown
 *    - "warn"     (yellow): degraded / blocked
 *    - "info"     (blue): default */
export declare function renderWaitingIndicator(label: string, startedAt: number | undefined, opts?: {
    eta?: number;
    hint?: string;
    style?: "info" | "warn" | "wait" | "thinking";
}): string;
export declare function truncate(s: string, max: number): string;
/** Word-wrap text into lines of at most `max` chars.
 *  Splits on spaces; if a single word exceeds `max` it is hard-broken.
 *  Ignores ANSI escape codes for length calculation. */
export declare function wrap(s: string, max: number): string[];
export declare function fmtTokens(n: number): string;
export declare function fmtDur(ms: number): string;
/** Context-fill percentage and color function for a token count vs safe limit. */
export declare function contextFillInfo(tokens: number, safe: number): {
    pct: number;
    color: typeof chalk;
};
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
export declare function renderFrame(swarm: Swarm, showHotkeys: boolean, runInfo?: RunInfo, selectedAgentId?: number, maxRows?: number, panel?: InteractivePanel): string;
export interface SteeringViewData {
    /** The ephemeral ticker heartbeat  -- elapsed, tool count, cost, current reasoning snippet. */
    statusLine: string;
    /** Persistent scrollback of discrete events (tool uses, retries, nudges). */
    events: SteeringEvent[];
    /** Optional context read from disk at setSteering() time. */
    context?: SteeringContext;
    /** Wall-clock ms the steering phase started, for the live elapsed indicator. */
    startedAt?: number;
}
export declare function renderSteeringFrame(runInfo: RunInfo, data: SteeringViewData, showHotkeys: boolean, rlGetter?: RLGetter, maxRows?: number, panel?: InteractivePanel): string;
export declare function renderSummary(swarm: Swarm): string;
