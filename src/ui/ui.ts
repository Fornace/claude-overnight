// Live in-terminal display for a run.
//
// `RunDisplay` orchestrates three things at 4 Hz:
//   1. Pull state from the active phase (a Swarm during a wave, or steering
//      data between waves) and hand it to the unified frame renderer.
//   2. Compose the frame with the input-prompt strip + interactive panel so
//      the prompt is never clipped off the bottom of the terminal.
//   3. Wire raw stdin through the keyboard pipeline (`keyboard.ts`) so
//      hotkeys (s/p/i/?/d/0-9/q) and paste behave consistently.
//
// All input *state* lives in `InputState`. All settings *fields* live in
// `settings.ts`. This file owns lifecycle and rendering only.

import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
import { renderFrame, renderSteeringFrame } from "./render.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { InteractivePanel } from "./interactive-panel.js";
import type { AskState, LiveConfig, RunInfo, SteeringContext, SteeringEvent } from "./types.js";
import {
  InputState,
  type KeyboardHost,
  bindKeyboard,
  renderInputPrompt,
} from "./keyboard.js";
import {
  type NavContext,
  type NavState,
  newNavState,
  navigate as navigateNav,
  highlightKey as navHighlightKey,
} from "./nav.js";

// Re-export the public types so external callers keep importing from "./ui.js".
export type { AskState, LiveConfig, RunInfo, SteeringContext, SteeringEvent } from "./types.js";

const MAX_STEERING_EVENTS = 60;
const MAX_ASK_LINES = 40;

/** Visible lines for the ask panel, clamped to leave room for header/content/footer/input. */
function askDisplayCap(): number {
  return Math.max(3, Math.min(MAX_ASK_LINES, (process.stdout.rows || 40) - 20));
}
let askTempDir: string | undefined;

export class RunDisplay implements KeyboardHost {
  readonly runInfo: RunInfo;
  readonly panel = new InteractivePanel();

  // Phase state — exactly one of `swarm` or `steeringActive` is meaningful at a time.
  private _swarm?: Swarm;
  private _liveConfig?: LiveConfig;
  private steeringActive = false;
  private steeringStatusLine = "Assessing...";
  private steeringStartedAt = 0;
  private steeringEvents: SteeringEvent[] = [];
  private steeringContext?: SteeringContext;
  private rlGetter?: RLGetter;

  // Render loop state
  private interval?: ReturnType<typeof setInterval>;
  private keyHandler?: (buf: Buffer) => void;
  private started = false;
  private readonly isTTY: boolean;
  private lastSeq = 0;
  private lastCompleted = -1;
  private lastFrame = "";

  // Input + selection state — KeyboardHost surface.
  private readonly inputState = new InputState();
  private _selectedAgentId?: number;
  private readonly navState: NavState = newNavState();

  // Side-query (ask) state
  private _askState?: AskState;
  private _askBusy = false;
  private askTempFile?: string;

  // External callbacks
  private readonly onSteer?: (text: string) => void;
  private readonly onAsk?: (text: string) => void;

  constructor(
    runInfo: RunInfo,
    liveConfig?: LiveConfig,
    callbacks?: { onSteer?: (text: string) => void; onAsk?: (text: string) => void },
  ) {
    this.runInfo = runInfo;
    this._liveConfig = liveConfig;
    this.onSteer = callbacks?.onSteer;
    this.onAsk = callbacks?.onAsk;
    this.isTTY = !!process.stdout.isTTY;
  }

  // ── KeyboardHost surface ──
  get swarm(): Swarm | undefined { return this._swarm; }
  get liveConfig(): LiveConfig | undefined { return this._liveConfig; }
  get selectedAgentId(): number | undefined { return this._selectedAgentId; }
  get askState(): AskState | undefined { return this._askState; }
  get askBusy(): boolean { return this._askBusy; }
  get hasOnSteer(): boolean { return !!this.onSteer; }
  get hasOnAsk(): boolean { return !!this.onAsk; }
  get hasAskTempFile(): boolean { return !!this.askTempFile; }

  // Backwards-compat alias (used by run.ts via callsites that read .swarm directly).
  getSelectedAgentId(): number | undefined { return this._selectedAgentId; }

  // ── Selection ──

  /** Cycle the selected agent detail to the next running agent (or first running if none selected). */
  cycleSelectedAgent(): void {
    if (!this._swarm) return;
    const running = this._swarm.agents.filter(a => a.status === "running");
    if (running.length === 0) { this._selectedAgentId = undefined; return; }
    if (this._selectedAgentId == null) { this._selectedAgentId = running[0].id; return; }
    const idx = running.findIndex(a => a.id === this._selectedAgentId);
    this._selectedAgentId = running[(idx + 1) % running.length].id;
  }

  /** Select a specific agent by ID for the detail panel. */
  selectAgent(id: number): void {
    if (!this._swarm) return;
    const agent = this._swarm.agents.find(a => a.id === id);
    if (agent && agent.status === "running") this._selectedAgentId = id;
  }

  /** Clear the agent detail panel. */
  clearSelectedAgent(): void { this._selectedAgentId = undefined; }

  // ── Ask side-query ──

  /** Replace the ask state. Called by run.ts as the side query streams and completes. */
  setAsk(state: AskState | undefined): void {
    this._askState = state;
    this.clearAskTempFile();
    if (state && !state.streaming && !state.error && state.answer) {
      const lines = state.answer.split("\n");
      if (lines.length > askDisplayCap()) {
        try {
          askTempDir = mkdtempSync(join(tmpdir(), "overnight-ask-"));
          this.askTempFile = join(askTempDir, "answer.txt");
          writeFileSync(this.askTempFile, state.answer, "utf8");
        } catch {}
      }
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

  setAskBusy(busy: boolean): void { this._askBusy = busy; }

  /** Used by the keyboard pipeline to dismiss a completed ask without
   *  re-running the full setAsk teardown. */
  clearAskState(): void {
    this._askState = undefined;
    this.clearAskTempFile();
  }

  openAskTempFile(): void {
    if (!this.askTempFile) return;
    try { execSync(`open -R ${JSON.stringify(this.askTempFile)}`); } catch {}
  }

  private clearAskTempFile(): void {
    if (this.askTempFile) {
      try { rmSync(this.askTempFile, { force: true }); } catch {}
      if (askTempDir) { try { rmSync(askTempDir, { recursive: true, force: true }); } catch {} }
      this.askTempFile = undefined;
      askTempDir = undefined;
    }
  }

  // ── Steer / ask callbacks invoked from the keyboard pipeline ──

  emitSteer(text: string): void { this.onSteer?.(text); }
  emitAsk(text: string): void { this.onAsk?.(text); }

  // ── Debrief (panel content) ──

  /** Set or clear the debrief text shown in the interactive panel. */
  setDebrief(text: string | undefined, label?: string): void {
    if (text) {
      this.panel.set({ mode: "debrief", header: "Debrief", preview: text, body: text });
      if (label && !text.startsWith("Summarizing")) {
        this.panel.appendHistory(label, text);
      }
    } else if (this.panel.state.mode === "debrief") {
      this.panel.set({ mode: "none", header: "", preview: "", body: "" });
    }
  }

  // ── Navigation ──

  /** The view of phase state the navigator needs. Built fresh each call so it
   *  always reflects the latest swarm/steering snapshot. */
  private navContext(): NavContext {
    return {
      swarm: this._swarm,
      steeringActive: this.steeringActive,
      steeringEvents: this.steeringEvents,
      steeringContext: this.steeringContext,
      selectedAgentId: this._selectedAgentId,
      selectAgent: (id: number) => this.selectAgent(id),
      clearSelectedAgent: () => this.clearSelectedAgent(),
    };
  }

  /** Arrow-key navigation dispatched by the keyboard pipeline. */
  navigate(direction: "up" | "down" | "left" | "right" | "enter"): boolean {
    return navigateNav(this.navContext(), this.navState, direction);
  }

  /** Returns the unique highlight key for the currently focused row, used by renderer. */
  getHighlightKey(): string | undefined {
    return navHighlightKey(this.navContext(), this.navState);
  }

  // ── Lifecycle ──

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrame = "";
    this.setupHotkeys();
    this.resumeInterval();
  }

  setWave(swarm: Swarm): void {
    this._swarm = swarm;
    this.steeringActive = false;
    this.rlGetter = undefined;
    this.lastSeq = 0;
    this.lastCompleted = -1;
  }

  setSteering(rlGetter?: RLGetter, ctx?: SteeringContext): void {
    this._swarm = undefined;
    this.steeringActive = true;
    this.steeringStatusLine = "Assessing...";
    this.steeringStartedAt = Date.now();
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

  /** Backwards-compat alias — treats input as the current status line. */
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

  // ── Render ──

  /** Write the full frame to stdout, clamped to terminal height.
   *  Layout: header + content (elastic) + footer + input/ask (fixed).
   *  The content area shrinks so input prompts are never clipped. */
  private flush(): void {
    try {
      const maxRows = (process.stdout.rows || 40) - 1;
      const frame = this.render(maxRows);
      if (frame === this.lastFrame) return; // nothing changed
      this.lastFrame = frame;
      process.stdout.write("\x1B[H\x1B[J" + frame);
    } catch { this.pause(); }
  }

  private render(maxRows?: number): string {
    const w = Math.max((process.stdout.columns ?? 80) || 80, 60);

    // Fullscreen panel takes over the entire terminal when expanded — all of
    // the normal UI (header, agent list, footer, input prompt) is hidden
    // behind it until the user presses Esc or Ctrl-O to collapse.
    if (this.panel.visible && this.panel.state.expanded) {
      const h = maxRows ?? ((process.stdout.rows || 40) - 1);
      return this.panel.renderFullscreen(w, h);
    }

    const inputPrompt = renderInputPrompt(this, this.inputState);
    const panelCollapsed = this.panel.visible ? this.panel.renderCollapsed(w) : "";
    const bottom = inputPrompt + (panelCollapsed ? "\n" + panelCollapsed : "");
    // `bottom` always starts with "\n" (renderInputPrompt prefixes, and the panel
    // branch prepends "\n"). Each newline consumes exactly one visual row, so
    // bottomRows == count of newlines — no +1.
    const bottomRows = bottom ? (bottom.match(/\n/g) || []).length : 0;
    const frameBudget = maxRows != null ? maxRows - bottomRows : undefined;

    let frame = "";
    if (this._swarm) {
      frame = renderFrame(this._swarm, this.hasHotkeys(), this.runInfo, this._selectedAgentId, frameBudget, this.panel);
    } else if (this.steeringActive) {
      frame = renderSteeringFrame(this.runInfo, {
        statusLine: this.steeringStatusLine,
        events: this.steeringEvents,
        context: this.steeringContext,
        startedAt: this.steeringStartedAt,
      }, this.hasHotkeys(), this.rlGetter, frameBudget, this.panel);
    } else {
      return "";
    }
    return frame + bottom;
  }

  private hasHotkeys(): boolean {
    return !!this._liveConfig && !!process.stdin.isTTY;
  }

  private setupHotkeys(): void {
    if (!this._liveConfig || !process.stdin.isTTY) return;
    try { process.stdin.setRawMode!(true); process.stdin.resume(); } catch { return; }
    try { process.stdout.write("\x1B[?2004h"); } catch {}
    this.keyHandler = bindKeyboard(this, this.inputState, () => this.flush());
  }

  // ── Plain-mode (non-TTY) progress ──

  private plainTick(): void {
    if (!this._swarm) return;
    const swarm = this._swarm;
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

