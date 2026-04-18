export type PanelMode = "debrief" | "ask" | "custom" | "none";
export interface DebriefEntry {
    label: string;
    text: string;
    time: number;
}
/** Mutable state of the interactive panel. */
export interface PanelState {
    mode: PanelMode;
    expanded: boolean;
    scrollOffset: number;
    header: string;
    preview: string;
    body: string;
}
export declare class InteractivePanel {
    state: PanelState;
    private _bodyLines;
    /** Accumulated debrief entries — each wave/phase appends one. */
    private _debriefHistory;
    set(params: {
        mode: PanelMode;
        header: string;
        preview: string;
        body: string;
    }): void;
    /** Append a debrief entry to the running history. Only meaningful in debrief mode. */
    appendHistory(label: string, text: string): void;
    /** Close the panel entirely (set mode to "none"). */
    close(): void;
    collapse(): void;
    toggle(): void;
    scroll(direction: "up" | "down", visibleRows: number): void;
    pageScroll(direction: "up" | "down", visibleRows: number): void;
    scrollToTop(): void;
    scrollToBottom(visibleRows: number): void;
    get visible(): boolean;
    /** Compact card — padded green-bg block with title + preview. Multi-line. */
    renderCollapsed(width: number): string;
    /** Fullscreen expanded view — fills the entire terminal. */
    renderFullscreen(width: number, height: number): string;
}
