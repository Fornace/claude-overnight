import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import type { RateLimitWindow, RLGetter, WaveSummary } from "./types.js";
import { renderFrame, renderSteeringFrame } from "./render.js";
import {
  type InputSegment,
  splitPaste,
  segmentsToString,
  renderSegments,
  appendCharToSegments,
  appendPasteToSegments,
  backspaceSegments,
} from "./cli.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { InteractivePanel, type PanelMode } from "./interactive-panel.js";

/** Short-lived context the steering view renders around its live log. */
export interface SteeringContext {
  objective?: string;
  status?: string;
  lastWave?: WaveSummary;
}

/** One scrollback line in the steering event log. */
export interface SteeringEvent { time: number; text: string }

/** Cumulative run-level stats  -- mutable, updated between phases. */
export interface RunInfo {
  accIn: number;
  accOut: number;
  accCost: number;
  accCompleted: number;
  accFailed: number;
  sessionsBudget: number;
  waveNum: number;
  remaining: number;
  model?: string;
  startedAt: number;
  /** Number of pending directives in the steer inbox; displayed as a chip in the hotkey row. */
  pendingSteer?: number;
}

/** Mutable config that can be changed live during execution. */
export interface LiveConfig {
  remaining: number;
  usageCap: number | undefined;
  concurrency: number;
  paused: boolean;
  dirty: boolean;
  /** Overage spend cap ($)  -- undefined = unlimited. Synced from the [e] hotkey. */
  extraUsageBudget?: number;
}

/** State of an in-flight or recently-completed ask side query. */
export interface AskState {
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
}

/** Navigation state for arrow-key traversal within the TUI content area. */
interface NavState {
  focusSection: number;
  focusRow: number;
  scrollOffset: number;
}

const MAX_STEERING_EVENTS = 60;
const MAX_INPUT_LEN = 600;
const MAX_ASK_LINES = 40;

/** Visible lines for the ask panel, clamped to leave room for header/content/footer/input. */
function askDisplayCap(): number {
  return Math.max(3, Math.min(MAX_ASK_LINES, (process.stdout.rows || 40) - 20));
}
let askTempDir: string | undefined;

export class RunDisplay {
  readonly runInfo: RunInfo;
  private liveConfig?: LiveConfig;
  private swarm?: Swarm;
  private steeringActive = false;
  private steeringStatusLine = "Assessing...";
  private steeringEvents: SteeringEvent[] = [];
  private steeringContext?: SteeringContext;
  private rlGetter?: RLGetter;
  private interval?: ReturnType<typeof setInterval>;
  private keyHandler?: (buf: Buffer) => void;
  private inputMode: "none" | "budget" | "threshold" | "concurrency" | "extra" | "steer" | "ask" = "none";
  private inputSegs: InputSegment[] = [];
  private started = false;
  private readonly isTTY: boolean;
  private lastSeq = 0;
  private lastCompleted = -1;
  private askState?: AskState;
  private askBusy = false;
  private askTempFile?: string;
  /** ID of the agent whose detail panel is open; undefined = no detail shown. */
  private selectedAgentId?: number;
  private navState: NavState = { focusSection: 0, focusRow: 0, scrollOffset: 0 };
  /** Interactive panel for debrief, Q&A, and other user-facing content. */
  readonly panel = new InteractivePanel();
  private onSteer?: (text: string) => void;
  private onAsk?: (text: string) => void;
  /** Set or clear the debrief text shown in the interactive panel. */
  setDebrief(text: string | undefined): void {
    if (text) {
      this.panel.set({ mode: "debrief", header: "Debrief", preview: text, body: text });
    } else if (this.panel.state.mode === "debrief") {
      this.panel.set({ mode: "none", header: "", preview: "", body: "" });
    }
  }

  constructor(
    runInfo: RunInfo,
    liveConfig?: LiveConfig,
    callbacks?: { onSteer?: (text: string) => void; onAsk?: (text: string) => void },
  ) {
    this.runInfo = runInfo;
    this.liveConfig = liveConfig;
    this.onSteer = callbacks?.onSteer;
    this.onAsk = callbacks?.onAsk;
    this.isTTY = !!process.stdout.isTTY;
  }

  /** Replace the ask state. Called by run.ts as the side query streams and completes. */
  setAsk(state: AskState | undefined): void {
    this.askState = state;
    // Clean up previous temp file
    this.clearAskTempFile();
    // Write full answer to temp file when streaming is done and answer is long
    if (state && !state.streaming && !state.error && state.answer) {
      const lines = state.answer.split("\n");
      if (lines.length > askDisplayCap()) {
        try {
          askTempDir = mkdtempSync(join(tmpdir(), "overnight-ask-"));
          this.askTempFile = join(askTempDir, "answer.txt");
          writeFileSync(this.askTempFile, state.answer, "utf8");
        } catch {}
      }
      // Also populate the panel with the Q&A content
      const preview = state.answer.split("\n")[0]?.slice(0, 120) || "(answered)";
      this.panel.set({
        mode: "ask",
        header: `Ask`,
        preview,
        body: `Q: ${state.question}\n\nA: ${state.answer}`,
      });
    } else if (state && state.error) {
      this.panel.set({ mode: "ask", header: "Ask", preview: state.error, body: `Q: ${state.question}\n\nError: ${state.error}` });
    } else if (!state && this.panel.state.mode === "ask") {
      this.panel.set({ mode: "none", header: "", preview: "", body: "" });
    }
  }

  /** Signal to the UI whether an ask is in progress (prevents duplicate firings). */
  setAskBusy(busy: boolean): void { this.askBusy = busy; }

  /** Cycle the selected agent detail to the next running agent (or first running if none selected). */
  cycleSelectedAgent(): void {
    if (!this.swarm) return;
    const running = this.swarm.agents.filter(a => a.status === "running");
    if (running.length === 0) { this.selectedAgentId = undefined; return; }
    if (this.selectedAgentId == null) { this.selectedAgentId = running[0].id; return; }
    const idx = running.findIndex(a => a.id === this.selectedAgentId);
    this.selectedAgentId = running[(idx + 1) % running.length].id;
  }

  /** Select a specific agent by ID for the detail panel. */
  selectAgent(id: number): void {
    if (!this.swarm) return;
    const agent = this.swarm.agents.find(a => a.id === id);
    if (agent && agent.status === "running") this.selectedAgentId = id;
  }

  /** Clear the agent detail panel. */
  clearSelectedAgent(): void { this.selectedAgentId = undefined; }

  /** Arrow-key navigation dispatched by the demux in handleTyped(). */
  navigate(direction: "up" | "down" | "left" | "right" | "enter"): boolean {
    const sections = this.getSections();
    const nav = this.navState;
    const section = sections[Math.min(nav.focusSection, sections.length - 1)];
    let changed = false;

    switch (direction) {
      case "up":
        if (nav.focusRow > 0) {
          nav.focusRow--;
          nav.scrollOffset = Math.max(0, nav.scrollOffset - 1);
          changed = true;
        } else if (nav.focusSection > 0) {
          nav.focusSection--;
          const prevSection = sections[nav.focusSection];
          nav.focusRow = Math.max(0, prevSection.rowCount - 1);
          changed = true;
        }
        break;
      case "down":
        if (nav.focusRow < section.rowCount - 1) {
          nav.focusRow++;
          changed = true;
        } else if (nav.focusSection < sections.length - 1) {
          nav.focusSection++;
          nav.focusRow = 0;
          changed = true;
        }
        break;
      case "left":
        if (this.selectedAgentId != null) {
          this.clearSelectedAgent();
          changed = true;
        } else if (nav.focusSection > 0) {
          nav.focusSection--;
          nav.focusRow = 0;
          changed = true;
        }
        break;
      case "right":
        if (this.swarm && this.selectedAgentId == null) {
          const agents = this.getVisibleAgents();
          const agent = agents[nav.focusRow];
          if (agent && agent.status === "running") {
            this.selectAgent(agent.id);
            changed = true;
          }
        } else if (nav.focusSection < sections.length - 1) {
          nav.focusSection++;
          nav.focusRow = 0;
          changed = true;
        }
        break;
      case "enter":
        if (this.swarm) {
          const agents = this.getVisibleAgents();
          const agent = agents[nav.focusRow];
          if (agent) {
            if (this.selectedAgentId === agent.id) {
              this.clearSelectedAgent();
            } else {
              this.selectAgent(agent.id);
            }
            changed = true;
          }
        }
        break;
    }

    this.clampNavState(sections);
    return changed;
  }

  /** Get the agents visible in the table (running + last N finished). */
  private getVisibleAgents(): import("./types.js").AgentState[] {
    if (!this.swarm) return [];
    const running = this.swarm.agents.filter(a => a.status === "running");
    const finished = this.swarm.agents.filter(a => a.status !== "running");
    const showFinished = finished.slice(-Math.max(2, 12 - running.length));
    return [...running, ...showFinished];
  }

  /** Discover sections from the current render state for navigation boundaries. */
  private getSections(): { title: string; rowCount: number; highlightKeyForRow: (row: number) => string | undefined }[] {
    const sections: { title: string; rowCount: number; highlightKeyForRow: (row: number) => string | undefined }[] = [];

    if (this.swarm) {
      // Agent table section
      const show = this.getVisibleAgents();
      sections.push({
        title: "Agents",
        rowCount: show.length,
        highlightKeyForRow: (row: number) => show[row]?.id != null ? `agent-${show[row].id}` : undefined,
      });

      // Agent detail section
      if (this.selectedAgentId != null) {
        sections.push({
          title: "Detail",
          rowCount: 1,
          highlightKeyForRow: () => "detail",
        });
      }

      // Merge results section
      if (this.swarm.mergeResults.length > 0) {
        sections.push({
          title: "Merges",
          rowCount: this.swarm.mergeResults.length,
          highlightKeyForRow: (row: number) => `merge-${row}`,
        });
      }

      // Event log section
      sections.push({
        title: "Events",
        rowCount: Math.min(12, this.swarm.logs.length),
        highlightKeyForRow: (row: number) => `event-${row}`,
      });
    } else if (this.steeringActive) {
      // Steering mode sections
      if (this.steeringContext?.objective) {
        sections.push({ title: "Objective", rowCount: 1, highlightKeyForRow: () => "objective" });
      }
      if (this.steeringContext?.status) {
        sections.push({ title: "Status", rowCount: 1, highlightKeyForRow: () => "status" });
      }
      if (this.steeringContext?.lastWave) {
        sections.push({ title: "LastWave", rowCount: Math.min(6, this.steeringContext.lastWave.tasks.length + 1), highlightKeyForRow: (row: number) => `wave-task-${row}` });
      }
      sections.push({ title: "PlannerActivity", rowCount: Math.min(15, this.steeringEvents.length), highlightKeyForRow: (row: number) => `steer-event-${row}` });
      sections.push({ title: "StatusLine", rowCount: 1, highlightKeyForRow: () => "status-line" });
    }

    // Ensure at least one section
    if (sections.length === 0) {
      sections.push({ title: "Content", rowCount: 1, highlightKeyForRow: () => "content" });
    }

    return sections;
  }

  private clampNavState(sections: ReturnType<RunDisplay["getSections"]>): void {
    const nav = this.navState;
    nav.focusSection = Math.min(Math.max(0, nav.focusSection), sections.length - 1);
    const s = sections[nav.focusSection];
    if (s) {
      nav.focusRow = Math.min(Math.max(0, nav.focusRow), Math.max(0, s.rowCount - 1));
    }
  }

  /** Returns the unique highlight key for the currently focused row, used by renderer. */
  getHighlightKey(): string | undefined {
    const sections = this.getSections();
    const nav = this.navState;
    const section = sections[Math.min(nav.focusSection, sections.length - 1)];
    return section?.highlightKeyForRow?.(nav.focusRow);
  }

  private clearAskTempFile(): void {
    if (this.askTempFile) {
      try { rmSync(this.askTempFile, { force: true }); } catch {}
      if (askTempDir) { try { rmSync(askTempDir, { recursive: true, force: true }); } catch {} }
      this.askTempFile = undefined;
      askTempDir = undefined;
    }
  }

  /** Get the currently selected agent's ID for rendering. */
  getSelectedAgentId(): number | undefined { return this.selectedAgentId; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupHotkeys();
    this.resumeInterval();
  }

  setWave(swarm: Swarm): void {
    this.swarm = swarm;
    this.steeringActive = false;
    this.rlGetter = undefined;
    this.lastSeq = 0;
    this.lastCompleted = -1;
  }

  setSteering(rlGetter?: RLGetter, ctx?: SteeringContext): void {
    this.swarm = undefined;
    this.steeringActive = true;
    this.steeringStatusLine = "Assessing...";
    this.steeringEvents = [];
    this.steeringContext = ctx;
    this.rlGetter = rlGetter;
  }

  /** Replace the single live status line (ticker heartbeat). */
  updateSteeringStatus(text: string): void { this.steeringStatusLine = text; }

  /** Append a discrete, persistent line to the steering scrollback. */
  appendSteeringEvent(text: string): void {
    this.steeringEvents.push({ time: Date.now(), text });
    if (this.steeringEvents.length > MAX_STEERING_EVENTS) this.steeringEvents.shift();
  }

  /** Backwards-compat alias  -- treats input as the current status line. */
  updateText(text: string): void { this.updateSteeringStatus(text); }

  pause(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
  }

  resume(): void {
    if (!this.started || this.interval) return;
    if (this.isTTY) try { process.stdout.write("\x1B[?25l"); } catch {}
    this.resumeInterval();
  }

  stop(): void {
    this.pause();
    if (this.keyHandler) {
      process.stdin.removeListener("data", this.keyHandler);
      this.keyHandler = undefined;
      try { process.stdout.write("\x1B[?2004l"); } catch {}
      try { process.stdin.setRawMode!(false); process.stdin.pause(); } catch {}
    }
    try { process.stdout.write("\x1B[?25h"); } catch {}
    // Clean up ask temp file
    this.clearAskTempFile();
    this.started = false;
  }

  private resumeInterval(): void {
    if (this.interval) return;
    if (!this.isTTY) {
      this.interval = setInterval(() => this.plainTick(), 500);
      return;
    }
    try { process.stdout.write("\x1B[?25l\x1B[H\x1B[J"); } catch { return; }
    this.interval = setInterval(() => this.flush(), 250);
  }

  /** Write the full frame to stdout, clamped to terminal height.
   *  Layout: header + content (elastic) + footer + input/ask (fixed).
   *  The content area shrinks so input prompts are never clipped. */
  private flush(): void {
    try {
      const maxRows = (process.stdout.rows || 40) - 1;
      const frame = this.render(maxRows);
      process.stdout.write("\x1B[H\x1B[J" + frame);
    } catch { this.pause(); }
  }

  private render(maxRows?: number): string {
    const w = Math.max((process.stdout.columns ?? 80) || 80, 60);

    // Fullscreen panel takes over the entire terminal when expanded —
    // all of the normal UI (header, agent list, footer, input prompt) is
    // hidden behind it until the user presses Esc or Ctrl-O to collapse.
    if (this.panel.visible && this.panel.state.expanded) {
      const h = maxRows ?? ((process.stdout.rows || 40) - 1);
      return this.panel.renderFullscreen(w, h);
    }

    // Compute how many rows the bottom area (input prompt + collapsed panel) need.
    const inputPrompt = this.renderInputPrompt();
    const panelCollapsed = this.panel.visible
      ? this.panel.renderCollapsed(w)
      : "";
    const bottom = inputPrompt + (panelCollapsed ? "\n" + panelCollapsed : "");
    const bottomRows = bottom ? (bottom.match(/\n/g) || []).length + 1 : 0;
    const frameBudget = maxRows != null ? maxRows - bottomRows : undefined;

    let frame = "";
    if (this.swarm) {
      frame = renderFrame(this.swarm, this.hasHotkeys(), this.runInfo, this.selectedAgentId, frameBudget, this.panel);
    } else if (this.steeringActive) {
      frame = renderSteeringFrame(this.runInfo, {
        statusLine: this.steeringStatusLine,
        events: this.steeringEvents,
        context: this.steeringContext,
      }, this.hasHotkeys(), this.rlGetter, frameBudget, this.panel);
    } else {
      return "";
    }
    return frame + bottom;
  }

  private renderInputPrompt(): string {
    if (this.inputMode === "none") return "";
    const rendered = renderSegments(this.inputSegs);
    if (this.inputMode === "budget") {
      return `\n  ${chalk.cyan(">")} New budget (remaining sessions): ${rendered}\u2588`;
    }
    if (this.inputMode === "threshold") {
      return `\n  ${chalk.cyan(">")} New usage cap (0-100%): ${rendered}\u2588`;
    }
    if (this.inputMode === "concurrency") {
      return `\n  ${chalk.cyan(">")} New concurrency (min 1): ${rendered}\u2588`;
    }
    if (this.inputMode === "extra") {
      return `\n  ${chalk.cyan(">")} Extra usage $ cap (0 = stop on overage): ${rendered}\u2588`;
    }
    if (this.inputMode === "steer") {
      return `\n  ${chalk.cyan(">")} ${chalk.bold("Steer next wave")} ${chalk.dim("(Enter to queue, Esc to cancel)")}\n  ${rendered}\u2588`;
    }
    if (this.inputMode === "ask") {
      return `\n  ${chalk.cyan(">")} ${chalk.bold("Ask the planner")} ${chalk.dim("(Enter to send, Esc to cancel)")}\n  ${rendered}\u2588`;
    }
    return "";
  }

  private hasHotkeys(): boolean {
    return !!this.liveConfig && !!process.stdin.isTTY;
  }

  private setupHotkeys(): void {
    if (!this.liveConfig || !process.stdin.isTTY) return;
    try { process.stdin.setRawMode!(true); process.stdin.resume(); } catch { return; }
    try { process.stdout.write("\x1B[?2004h"); } catch {}

    this.keyHandler = (buf: Buffer) => {
      const chunk = buf.toString();
      let dirty = false;
      for (const seg of splitPaste(chunk)) {
        if (seg.type === "paste") {
          if (this.handlePaste(seg.text)) dirty = true;
        } else {
          if (this.handleTyped(seg.text)) dirty = true;
        }
      }
      if (dirty) this.flush();
    };
    process.stdin.on("data", this.keyHandler);
  }

  /** Handle a pasted block. Returns true if the frame needs a redraw. */
  private handlePaste(text: string): boolean {
    if (this.inputMode === "budget" || this.inputMode === "threshold" || this.inputMode === "concurrency" || this.inputMode === "extra") {
      const clean = text.replace(/[^0-9.]/g, "");
      if (clean) appendCharToSegments(this.inputSegs, clean);
      return !!clean;
    }
    if (this.inputMode === "steer" || this.inputMode === "ask") {
      if (segmentsToString(this.inputSegs).length + text.length > MAX_INPUT_LEN) return false;
      appendPasteToSegments(this.inputSegs, text);
      return true;
    }
    return false;
  }

  /** Keyboard handler used only while the panel is expanded fullscreen.
   *  Handles scroll + close. Swallows everything else so the normal hotkeys
   *  (b/t/c/p/s/?/d/0-9) do not fire while the user is reading. */
  private handlePanelKey(s: string): boolean {
    const bodyRows = Math.max(3, (process.stdout.rows || 40) - 7);
    // CSI sequences: arrows, PgUp/PgDn, Home/End
    if (s.startsWith("\x1B[")) {
      if (s === "\x1B[A") { this.panel.scroll("up", bodyRows); return true; }
      if (s === "\x1B[B") { this.panel.scroll("down", bodyRows); return true; }
      if (s === "\x1B[5~") { this.panel.pageScroll("up", bodyRows); return true; }
      if (s === "\x1B[6~") { this.panel.pageScroll("down", bodyRows); return true; }
      if (s === "\x1B[H" || s === "\x1B[1~") { this.panel.scrollToTop(); return true; }
      if (s === "\x1B[F" || s === "\x1B[4~") { this.panel.scrollToBottom(bodyRows); return true; }
      return false; // swallow other CSIs silently
    }
    // Bare ESC: collapse
    if (s === "\x1B") { this.panel.collapse(); return true; }
    // Ctrl-O: toggle (collapse)
    if (s === "\x0F") { this.panel.toggle(); return true; }
    // Ctrl-C: keep the usual abort / exit behavior even while expanded
    if (s === "\x03") {
      if (this.swarm && !this.swarm.aborted) { this.swarm.abort(); return true; }
      process.exit(0);
    }
    // Vim-style jumps
    if (s === "g") { this.panel.scrollToTop(); return true; }
    if (s === "G") { this.panel.scrollToBottom(bodyRows); return true; }
    // Space / j / k as extra scroll conveniences
    if (s === " " || s === "j") { this.panel.scroll("down", bodyRows); return true; }
    if (s === "k") { this.panel.scroll("up", bodyRows); return true; }
    // Swallow everything else
    return false;
  }

  /** Handle a typed (non-pasted) chunk. Returns true if the frame needs a redraw.
   *
   * Demux pipeline  -- routes escape sequences and modifiers BEFORE hotkey matching:
   *   Raw stdin chunk → splitPaste
   *     ├─ paste → handlePaste
   *     └─ typed → demux
   *          0. panel expanded  → handlePanelKey (steals all input)
   *          1. ESC + [A/B/C/D  → navigate; other CSI → swallow
   *          2. ESC + non-[     → Alt/Option+key → swallow
   *          3. ESC alone       → cancel input / close detail / dismiss panel
   *          4. numeric input   → digits, Enter, Backspace
   *          5. text input      → printable chars, Enter, Backspace, ESC (with lookahead)
   *          6. hotkey mode     → b, t, c, e, p, s, q, ?, d, 0-9
   */
  private handleTyped(s: string): boolean {
    const lc = this.liveConfig!;

    // ── 0. Fullscreen panel owns the keyboard ──
    // While the interactive panel is expanded it takes over the screen and
    // steals every key except Esc, Ctrl-O (close), Ctrl-C (abort), and scroll.
    // Hotkeys like b/t/c/p/s/? are intentionally swallowed so the user can
    // read without triggering side effects.
    if (this.panel.state.expanded) {
      return this.handlePanelKey(s);
    }

    // ── 1. Arrow keys: \x1B[A = up, \x1B[B = down, \x1B[C = right, \x1B[D = left ──
    if (s.startsWith("\x1B[")) {
      const dir = s[2];
      if (dir === "A") { this.navigate("up"); return true; }
      if (dir === "B") { this.navigate("down"); return true; }
      if (dir === "C") { this.navigate("right"); return true; }
      if (dir === "D") { this.navigate("left"); return true; }
      // Other ANSI sequences  -- swallow silently
      return true;
    }

    // ── 2. Alt/Option+key: \x1B followed by a non-bracket byte (e.g. \x1Bb, \x1Bf) ──
    if (s.length >= 2 && s[0] === "\x1B" && s[1] !== "[") {
      return false; // swallow — don't cancel input, don't trigger hotkeys
    }

    // ── 3. Standalone ESC ──
    if (s === "\x1B") {
      if (this.inputMode !== "none") {
        this.inputMode = "none";
        this.inputSegs = [];
        return true;
      }
      if (this.selectedAgentId != null) {
        this.clearSelectedAgent();
        return true;
      }
      if (this.askState && !this.askState.streaming) {
        this.askState = undefined;
        this.clearAskTempFile();
        return true;
      }
      return false;
    }

    // ── 4. Input mode: budget / threshold / concurrency / extra ──
    if (this.inputMode === "budget" || this.inputMode === "threshold" || this.inputMode === "concurrency" || this.inputMode === "extra") {
      let dirty = false;
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          const val = parseFloat(segmentsToString(this.inputSegs));
          if (this.inputMode === "budget" && !isNaN(val) && val > 0) {
            lc.remaining = Math.round(val);
            lc.dirty = true;
            this.swarm?.log(-1, `Budget changed to ${lc.remaining} remaining`);
          } else if (this.inputMode === "threshold" && !isNaN(val) && val >= 0 && val <= 100) {
            const frac = val / 100;
            lc.usageCap = frac > 0 ? frac : undefined;
            lc.dirty = true;
            if (this.swarm) this.swarm.usageCap = lc.usageCap;
            this.swarm?.log(-1, `Usage cap changed to ${val > 0 ? val + "%" : "unlimited"}`);
          } else if (this.inputMode === "concurrency" && !isNaN(val) && val >= 1) {
            const n = Math.round(val);
            lc.concurrency = n;
            lc.dirty = true;
            this.swarm?.setConcurrency(n);
          } else if (this.inputMode === "extra" && !isNaN(val) && val >= 0) {
            lc.extraUsageBudget = val;
            lc.dirty = true;
            this.swarm?.setExtraUsageBudget(val);
          }
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        if (ch === "\x03") {
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        if (ch === "\x7F") { backspaceSegments(this.inputSegs); dirty = true; continue; }
        if (/^[0-9.]$/.test(ch)) { appendCharToSegments(this.inputSegs, ch); dirty = true; }
      }
      return dirty;
    }

    // ── 5. Input mode: steer / ask ──
    if (this.inputMode === "steer" || this.inputMode === "ask") {
      let dirty = false;
      for (let ci = 0; ci < s.length; ci++) {
        const ch = s[ci];
        if (ch === "\r" || ch === "\n") {
          const text = segmentsToString(this.inputSegs).trim();
          const wasAsk = this.inputMode === "ask";
          this.inputMode = "none";
          this.inputSegs = [];
          if (text) {
            if (wasAsk) this.onAsk?.(text);
            else this.onSteer?.(text);
          }
          return true;
        }
        if (ch === "\x03") {
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        // ESC: if next byte exists it's part of an Alt+key sequence — skip both.
        // Standalone ESC (no following byte) cancels input mode.
        if (ch === "\x1B") {
          if (ci + 1 < s.length) { ci++; continue; }
          this.inputMode = "none";
          this.inputSegs = [];
          return true;
        }
        if (ch === "\x7F" || ch === "\b") {
          backspaceSegments(this.inputSegs);
          dirty = true;
          continue;
        }
        const code = ch.charCodeAt(0);
        if (code < 0x20) continue;
        if (code >= 0x7F && code < 0xA0) continue;
        if (code >= 0x20 && code <= 0x7E && segmentsToString(this.inputSegs).length < MAX_INPUT_LEN) {
          appendCharToSegments(this.inputSegs, ch);
          dirty = true;
        }
      }
      return dirty;
    }

    // ── 6. Hotkey mode ──

    // Enter
    if (s === "\r" || s === "\n") {
      if (this.askTempFile) {
        try { execSync(`open -R ${JSON.stringify(this.askTempFile)}`); } catch {}
      }
      return true;
    }

    // Ctrl+C
    if (s === "\x03") {
      if (this.swarm && !this.swarm.aborted) { this.swarm.abort(); }
      else { process.exit(0); }
      return true;
    }

    // Ctrl+O: toggle interactive panel expand/collapse
    if (s === "\x0F") {
      if (this.panel.visible) {
        this.panel.toggle();
        return true;
      }
      return false;
    }

    // Only single printable ASCII characters reach hotkey matching
    if (s.length !== 1) return false;
    const key = s[0];
    const code = key.charCodeAt(0);
    if (code < 0x20 || code > 0x7E) return false;

    if (key === "b" || key === "B") { this.inputMode = "budget"; this.inputSegs = []; return true; }
    if (key === "t" || key === "T") {
      if (this.swarm) { this.inputMode = "threshold"; this.inputSegs = []; return true; }
      return false;
    }
    if (key === "c" || key === "C") {
      if (this.swarm) { this.inputMode = "concurrency"; this.inputSegs = []; return true; }
      return false;
    }
    if (key === "e" || key === "E") {
      if (this.swarm) { this.inputMode = "extra"; this.inputSegs = []; return true; }
      return false;
    }
    if (key === "p" || key === "P") {
      if (this.swarm) {
        const next = !this.swarm.paused;
        this.swarm.setPaused(next);
        lc.paused = next;
        lc.dirty = true;
        return true;
      }
      return false;
    }
    if ((key === "f" || key === "F") && this.swarm && this.swarm.failed > 0 && this.swarm.active > 0) {
      this.swarm.requeueFailed();
      return false;
    }
    if ((key === "r" || key === "R") && this.swarm && this.swarm.rateLimitPaused > 0) {
      this.swarm.retryRateLimitNow();
      return true;
    }
    if ((key === "s" || key === "S") && this.onSteer) {
      this.inputMode = "steer"; this.inputSegs = []; return true;
    }
    if (key === "?" && this.onAsk && this.swarm && !this.askBusy) {
      if (this.askState && !this.askState.streaming) { this.askState = undefined; this.clearAskTempFile(); return true; }
      this.inputMode = "ask"; this.inputSegs = []; return true;
    }
    // [d] cycle agent detail panel
    if ((key === "d" || key === "D") && this.swarm && this.swarm.active > 0) {
      this.cycleSelectedAgent();
      return true;
    }
    // Number keys 0-9 select a specific agent by row index in the visible table
    if (/^[0-9]$/.test(key) && this.swarm) {
      const n = parseInt(key);
      const running = this.swarm.agents.filter(a => a.status === "running");
      if (n < running.length) { this.selectAgent(running[n].id); return true; }
    }
    if (key === "q" || key === "Q") {
      if (this.swarm) {
        if (this.swarm.aborted) process.exit(0);
        this.swarm.abort();
      } else {
        process.exit(0);
      }
    }
    return false;
  }

  private plainTick(): void {
    if (!this.swarm) return;
    const swarm = this.swarm;
    const write = (line: string) => { try { process.stdout.write(line + "\n"); } catch {} };
    const currentSeq = swarm.logSequence;
    if (currentSeq > this.lastSeq) {
      const newCount = currentSeq - this.lastSeq;
      const available = swarm.logs.length;
      const toShow = Math.min(newCount, available);
      for (const entry of swarm.logs.slice(available - toShow)) {
        const t = new Date(entry.time).toLocaleTimeString("en", { hour12: false });
        const tag = entry.agentId < 0 ? "[sys]" : `[${entry.agentId}]`;
        write(`${t} ${tag} ${entry.text}`);
      }
      this.lastSeq = currentSeq;
    }
    if (swarm.completed !== this.lastCompleted) {
      this.lastCompleted = swarm.completed;
      write(`progress: ${swarm.completed}/${swarm.total} done, ${swarm.active} active, ${swarm.pending} queued`);
    }
  }
}
