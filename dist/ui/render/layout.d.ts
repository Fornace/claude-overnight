/** A titled group of pre-rendered rows handed to the unified frame. The frame
 *  draws `title` as a divider (skipped when empty) and then the rows as-is. */
export interface Section {
    title: string;
    rows: string[];
    scrollable?: boolean;
    highlightKey?: string;
}
/** Contract between a phase-specific renderer and the unified frame: produce
 *  the sections for the content area, once per frame. */
export interface ContentRenderer {
    sections(): Section[];
}
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
    /** Layout budget — when set, content sections are trimmed so the total
     *  frame never exceeds this many lines. Header and footer are always
     *  rendered in full; only the content area shrinks. */
    maxRows?: number;
}): string;
