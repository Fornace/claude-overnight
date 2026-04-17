export type PanelMode = "debrief" | "ask" | "custom" | "none";

/** Mutable state of the interactive panel. */
export interface PanelState {
  mode: PanelMode;
  expanded: boolean;
  scrollOffset: number;
  header: string;
  preview: string;
  body: string;
}

const DARK_GREEN_BG = "\x1B[48;5;22m";
const LIGHT_GREEN_FG = "\x1B[38;5;156m";
const BRIGHT_WHITE_FG = "\x1B[38;5;231m";
const SOFT_GREEN_FG = "\x1B[38;5;114m";
const RESET = "\x1B[0m";

function padTo(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

/** Wrap a plain (ANSI-free) line in the dark-green bg, padded to width. */
function bgLine(text: string, width: number): string {
  return `${DARK_GREEN_BG}${LIGHT_GREEN_FG}${padTo(text, width)}${RESET}`;
}

export class InteractivePanel {
  state: PanelState = {
    mode: "none",
    expanded: false,
    scrollOffset: 0,
    header: "",
    preview: "",
    body: "",
  };
  private _bodyLines: string[] = [];

  set(params: { mode: PanelMode; header: string; preview: string; body: string }): void {
    this.state.mode = params.mode;
    this.state.header = params.header;
    this.state.preview = params.preview;
    this.state.body = params.body;
    this._bodyLines = params.body.split("\n").filter(l => l.length > 0);
    this.state.scrollOffset = 0;
  }

  collapse(): void {
    this.state.expanded = false;
    this.state.scrollOffset = 0;
  }

  toggle(): void {
    if (this.state.mode === "none") return;
    this.state.expanded = !this.state.expanded;
    if (!this.state.expanded) this.state.scrollOffset = 0;
  }

  scroll(direction: "up" | "down", visibleRows: number): void {
    if (!this.state.expanded) return;
    const maxScroll = Math.max(0, this._bodyLines.length - visibleRows);
    if (direction === "up") {
      this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 1);
    } else {
      this.state.scrollOffset = Math.min(maxScroll, this.state.scrollOffset + 1);
    }
  }

  pageScroll(direction: "up" | "down", visibleRows: number): void {
    if (!this.state.expanded) return;
    const maxScroll = Math.max(0, this._bodyLines.length - visibleRows);
    const delta = Math.max(1, visibleRows - 1);
    if (direction === "up") {
      this.state.scrollOffset = Math.max(0, this.state.scrollOffset - delta);
    } else {
      this.state.scrollOffset = Math.min(maxScroll, this.state.scrollOffset + delta);
    }
  }

  scrollToTop(): void { this.state.scrollOffset = 0; }
  scrollToBottom(visibleRows: number): void {
    this.state.scrollOffset = Math.max(0, this._bodyLines.length - visibleRows);
  }

  get visible(): boolean { return this.state.mode !== "none"; }

  /** Compact card — padded green-bg block with title + preview. Multi-line. */
  renderCollapsed(width: number): string {
    if (this.state.mode === "none" || !this.state.preview) return "";
    const boxW = Math.min(Math.max(40, width - 4), 140);

    const icon = "\u25B8"; // ▸
    const title = ` ${icon}  ${this.state.header}`;
    const hint = `Ctrl-O expand `;
    const titleRoom = Math.max(4, boxW - hint.length - 2);
    const titleTrim = truncate(title, titleRoom);
    const gap = Math.max(1, boxW - titleTrim.length - hint.length);
    const titleRow = titleTrim + " ".repeat(gap) + hint;

    const previewText = this.state.preview.replace(/\s+/g, " ").trim();
    const previewRow = `    ${truncate(previewText, boxW - 5)}`;

    return [
      "  " + bgLine("", boxW),
      "  " + bgLine(titleRow, boxW),
      "  " + bgLine(previewRow, boxW),
      "  " + bgLine("", boxW),
    ].join("\n");
  }

  /** Fullscreen expanded view — fills the entire terminal. */
  renderFullscreen(width: number, height: number): string {
    if (this.state.mode === "none") return "";
    const total = this._bodyLines.length;
    const headerRows = 3;
    const footerRows = 3;
    const bodyRows = Math.max(3, height - headerRows - footerRows);
    const innerW = Math.max(20, width - 8);

    // Clamp scroll to valid range whenever terminal resizes
    const maxScroll = Math.max(0, total - bodyRows);
    if (this.state.scrollOffset > maxScroll) this.state.scrollOffset = maxScroll;
    const start = this.state.scrollOffset;
    const end = Math.min(start + bodyRows, total);

    // Header bar: blank · title + position · blank
    const icon = "\u25BE"; // ▾
    const titleText = ` ${icon}  ${this.state.header}`;
    const position = total > bodyRows
      ? ` ${start + 1}\u2013${end} / ${total} `
      : total > 0 ? ` ${total} lines ` : "";
    const gap = Math.max(1, width - titleText.length - position.length);
    const titleRow = titleText + " ".repeat(gap) + position;

    const out: string[] = [];
    out.push(bgLine("", width));
    out.push(bgLine(titleRow, width));
    out.push(bgLine("", width));

    // Body with left/right padding
    let emitted = 0;
    for (let i = start; i < end; i++) {
      const ln = truncate(this._bodyLines[i], innerW);
      out.push(`    ${BRIGHT_WHITE_FG}${ln}${RESET}`);
      emitted++;
    }
    if (total === 0) {
      out.push(`    ${SOFT_GREEN_FG}(empty)${RESET}`);
      emitted = 1;
    }
    while (emitted < bodyRows) { out.push(""); emitted++; }

    // Footer bar: blank · hints · blank
    const hints = " \u2191\u2193 scroll  \u00b7  PgUp/PgDn page  \u00b7  g/G top\u2022end  \u00b7  Esc or Ctrl-O close ";
    const hintTrim = truncate(hints, width);
    out.push(bgLine("", width));
    out.push(bgLine(hintTrim, width));
    out.push(bgLine("", width));

    return out.join("\n");
  }
}
