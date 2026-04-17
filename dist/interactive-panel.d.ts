export type PanelMode = "debrief" | "ask" | "custom" | "none";
/** Mutable state of the interactive panel. */
export interface PanelState {
    mode: PanelMode;
    expanded: boolean;
    scrollOffset: number;
    /** Short title shown in the header bar. */
    header: string;
    /** One-line summary shown when collapsed. */
    preview: string;
    /** Multi-line body shown when expanded. */
    body: string;
    /** Whether to show a text input at the bottom (ask/steer). */
    inputActive: boolean;
    inputPlaceholder?: string;
}
export declare class InteractivePanel {
    state: PanelState;
    /** Cached non-empty body lines — rebuilt when body changes. */
    private _bodyLines;
    /** Set or clear the panel content. Mode "none" hides it. */
    set(params: {
        mode: PanelMode;
        header: string;
        preview: string;
        body: string;
    }): void;
    /** Collapse the panel back to the compact bar. */
    collapse(): void;
    /** Toggle expanded/collapsed state. */
    toggle(): void;
    /** Scroll up/down within the expanded body. */
    scroll(direction: "up" | "down", visibleRows: number): void;
    /** Whether the panel is currently visible (any mode other than none). */
    get visible(): boolean;
    /** Render the collapsed compact bar. Returns empty string if no content. */
    renderCollapsed(width: number): string;
    /** Render the expanded panel as an array of lines for the content area. */
    renderExpanded(width: number, maxRows: number): string[];
}
