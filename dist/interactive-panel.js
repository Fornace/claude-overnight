import chalk from "chalk";
const DARK_GREEN_BG = "\x1B[48;5;22m";
const LIGHT_GREEN_FG = "\x1B[38;5;156m";
const RESET = "\x1B[0m";
function greenBg(text) {
    return `${DARK_GREEN_BG}${LIGHT_GREEN_FG} ${text} ${RESET}`;
}
function greenBgLine(text, width) {
    const padded = text.padEnd(Math.max(0, width));
    return `${DARK_GREEN_BG}${LIGHT_GREEN_FG}${padded}${RESET}`;
}
function truncate(s, max) {
    return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}
export class InteractivePanel {
    state = {
        mode: "none",
        expanded: false,
        scrollOffset: 0,
        header: "",
        preview: "",
        body: "",
        inputActive: false,
    };
    /** Cached non-empty body lines — rebuilt when body changes. */
    _bodyLines = [];
    /** Set or clear the panel content. Mode "none" hides it. */
    set(params) {
        this.state.mode = params.mode;
        this.state.header = params.header;
        this.state.preview = params.preview;
        this.state.body = params.body;
        // Rebuild cached lines and reset scroll only when content changes
        this._bodyLines = params.body.split("\n").filter(l => l.length > 0);
        this.state.scrollOffset = 0;
    }
    /** Collapse the panel back to the compact bar. */
    collapse() {
        this.state.expanded = false;
        this.state.scrollOffset = 0;
    }
    /** Toggle expanded/collapsed state. */
    toggle() {
        if (this.state.mode === "none")
            return;
        this.state.expanded = !this.state.expanded;
        if (!this.state.expanded)
            this.state.scrollOffset = 0;
    }
    /** Scroll up/down within the expanded body. */
    scroll(direction, visibleRows) {
        if (!this.state.expanded)
            return;
        const maxScroll = Math.max(0, this._bodyLines.length - visibleRows);
        if (direction === "up") {
            this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 1);
        }
        else {
            this.state.scrollOffset = Math.min(maxScroll, this.state.scrollOffset + 1);
        }
    }
    /** Whether the panel is currently visible (any mode other than none). */
    get visible() {
        return this.state.mode !== "none";
    }
    /** Render the collapsed compact bar. Returns empty string if no content. */
    renderCollapsed(width) {
        if (this.state.mode === "none" || !this.state.preview)
            return "";
        const icon = this.state.expanded ? "\u25BC" : "\u25B6";
        const modeLabel = this.state.header;
        const hint = chalk.dim(`[Ctrl-O expand]`);
        const content = truncate(this.state.preview, width - modeLabel.length - hint.length - 8);
        return `  ${greenBg(`${icon} ${modeLabel}`)} ${content} ${hint}`;
    }
    /** Render the expanded panel as an array of lines for the content area. */
    renderExpanded(width, maxRows) {
        if (this.state.mode === "none")
            return [];
        const innerW = Math.max(20, width - 6);
        const lines = [];
        // Header bar — full-width dark green bg
        const headerText = ` ${this.state.header}  ${chalk.dim("[Ctrl-O] collapse")}${this.state.inputActive ? chalk.dim("  [Esc] cancel") : ""}`;
        lines.push(greenBgLine(headerText, Math.min(width - 4, innerW + 2)));
        // Body content — scrolled
        const headerSpace = this.state.inputActive ? 3 : 2; // header + footer + optional input
        const visibleRows = Math.max(2, maxRows - headerSpace);
        const start = this.state.scrollOffset;
        const end = Math.min(start + visibleRows, this._bodyLines.length);
        for (let i = start; i < end; i++) {
            const ln = truncate(this._bodyLines[i], innerW);
            lines.push(`  ${chalk.greenBright(ln)}`);
        }
        if (end < this._bodyLines.length) {
            lines.push(chalk.dim(`  \u2026 +${this._bodyLines.length - end} more`));
        }
        if (this._bodyLines.length === 0) {
            lines.push(chalk.dim("  (empty)"));
        }
        // Footer hint
        if (this.state.inputActive && this.state.inputPlaceholder) {
            lines.push("");
            lines.push(`  ${chalk.cyan(">")} ${this.state.inputPlaceholder}`);
        }
        else if (!this.state.inputActive) {
            lines.push("");
            lines.push(chalk.dim("  \u2191\u2193 scroll  [Ctrl-O] collapse"));
        }
        return lines;
    }
}
