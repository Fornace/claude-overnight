import chalk from "chalk";
import { renderFrame, renderSteeringFrame } from "./render.js";
import { splitPaste, segmentsToString, renderSegments, appendCharToSegments, appendPasteToSegments, backspaceSegments, } from "../cli/cli.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { InteractivePanel } from "./interactive-panel.js";
import { allTurns, cycleFocused } from "../core/turns.js";
const MAX_STEERING_EVENTS = 60;
const MAX_INPUT_LEN = 600;
const MAX_ASK_LINES = 40;
const SETTINGS_FIELDS = ["budget", "cap", "conc", "extra", "worker", "planner", "fast", "perms", "pause"];
const NUMERIC_SETTINGS_FIELDS = new Set(["budget", "cap", "conc", "extra"]);
/** Visible lines for the ask panel, clamped to leave room for header/content/footer/input. */
function askDisplayCap() {
    return Math.max(3, Math.min(MAX_ASK_LINES, (process.stdout.rows || 40) - 20));
}
let askTempDir;
export class RunDisplay {
    runInfo;
    liveConfig;
    swarm;
    steeringActive = false;
    steeringStatusLine = "Assessing...";
    steeringStartedAt = 0;
    steeringEvents = [];
    steeringContext;
    rlGetter;
    interval;
    keyHandler;
    inputMode = "none";
    /** Which field the settings editor is currently editing. Order: budget, cap, conc, extra, worker, planner, fast, perms, pause. */
    settingsField = 0;
    inputSegs = [];
    started = false;
    isTTY;
    lastSeq = 0;
    lastCompleted = -1;
    askState;
    askBusy = false;
    askTempFile;
    /** ID of the agent whose detail panel is open; undefined = no detail shown. */
    selectedAgentId;
    navState = { focusSection: 0, focusRow: 0, scrollOffset: 0 };
    /** Interactive panel for debrief, Q&A, and other user-facing content. */
    panel = new InteractivePanel();
    /** Cached frame string for deduplication — skip redraw when nothing changed. */
    lastFrame = "";
    onSteer;
    onAsk;
    /** Set or clear the debrief text shown in the interactive panel.
     *  When a label is provided alongside resolved text, it's appended to
     *  the running history so expanded view shows all wave debriefs. */
    setDebrief(text, label) {
        if (text) {
            this.panel.set({ mode: "debrief", header: "Debrief", preview: text, body: text });
            // Append to accumulated history when we have the final text (not loading message)
            if (label && !text.startsWith("Summarizing")) {
                this.panel.appendHistory(label, text);
            }
        }
        else if (this.panel.state.mode === "debrief") {
            this.panel.set({ mode: "none", header: "", preview: "", body: "" });
        }
    }
    constructor(runInfo, liveConfig, callbacks) {
        this.runInfo = runInfo;
        this.liveConfig = liveConfig;
        this.onSteer = callbacks?.onSteer;
        this.onAsk = callbacks?.onAsk;
        this.isTTY = !!process.stdout.isTTY;
    }
    /** Replace the ask state. Called by run.ts as the side query streams and completes. */
    setAsk(state) {
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
                }
                catch { }
            }
            // Also populate the panel with the Q&A content
            const preview = state.answer.split("\n")[0]?.slice(0, 120) || "(answered)";
            this.panel.set({
                mode: "ask",
                header: `Ask`,
                preview,
                body: `Q: ${state.question}\n\nA: ${state.answer}`,
            });
        }
        else if (state && state.error) {
            this.panel.set({ mode: "ask", header: "Ask", preview: state.error, body: `Q: ${state.question}\n\nError: ${state.error}` });
        }
        else if (!state && this.panel.state.mode === "ask") {
            this.panel.set({ mode: "none", header: "", preview: "", body: "" });
        }
    }
    /** Signal to the UI whether an ask is in progress (prevents duplicate firings). */
    setAskBusy(busy) { this.askBusy = busy; }
    /** Cycle the selected agent detail to the next running agent (or first running if none selected). */
    cycleSelectedAgent() {
        if (!this.swarm)
            return;
        const running = this.swarm.agents.filter(a => a.status === "running");
        if (running.length === 0) {
            this.selectedAgentId = undefined;
            return;
        }
        if (this.selectedAgentId == null) {
            this.selectedAgentId = running[0].id;
            return;
        }
        const idx = running.findIndex(a => a.id === this.selectedAgentId);
        this.selectedAgentId = running[(idx + 1) % running.length].id;
    }
    /** Select a specific agent by ID for the detail panel. */
    selectAgent(id) {
        if (!this.swarm)
            return;
        const agent = this.swarm.agents.find(a => a.id === id);
        if (agent && agent.status === "running")
            this.selectedAgentId = id;
    }
    /** Clear the agent detail panel. */
    clearSelectedAgent() { this.selectedAgentId = undefined; }
    /** Arrow-key navigation dispatched by the demux in handleTyped(). */
    navigate(direction) {
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
                }
                else if (nav.focusSection > 0) {
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
                }
                else if (nav.focusSection < sections.length - 1) {
                    nav.focusSection++;
                    nav.focusRow = 0;
                    changed = true;
                }
                break;
            case "left":
                if (this.selectedAgentId != null) {
                    this.clearSelectedAgent();
                    changed = true;
                }
                else if (allTurns().length > 1) {
                    cycleFocused(-1);
                    changed = true;
                }
                else if (nav.focusSection > 0) {
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
                }
                else if (allTurns().length > 1) {
                    cycleFocused(1);
                    changed = true;
                }
                else if (nav.focusSection < sections.length - 1) {
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
                        }
                        else {
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
    getVisibleAgents() {
        if (!this.swarm)
            return [];
        const running = this.swarm.agents.filter(a => a.status === "running");
        const finished = this.swarm.agents.filter(a => a.status !== "running");
        const showFinished = finished.slice(-Math.max(2, 12 - running.length));
        return [...running, ...showFinished];
    }
    /** Discover sections from the current render state for navigation boundaries. */
    getSections() {
        const sections = [];
        if (this.swarm) {
            // Agent table section
            const show = this.getVisibleAgents();
            sections.push({
                title: "Agents",
                rowCount: show.length,
                highlightKeyForRow: (row) => show[row]?.id != null ? `agent-${show[row].id}` : undefined,
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
                    highlightKeyForRow: (row) => `merge-${row}`,
                });
            }
            // Event log section
            sections.push({
                title: "Events",
                rowCount: Math.min(12, this.swarm.logs.length),
                highlightKeyForRow: (row) => `event-${row}`,
            });
        }
        else if (this.steeringActive) {
            // Steering mode sections
            if (this.steeringContext?.objective) {
                sections.push({ title: "Objective", rowCount: 1, highlightKeyForRow: () => "objective" });
            }
            if (this.steeringContext?.status) {
                sections.push({ title: "Status", rowCount: 1, highlightKeyForRow: () => "status" });
            }
            if (this.steeringContext?.lastWave) {
                sections.push({ title: "LastWave", rowCount: Math.min(6, this.steeringContext.lastWave.tasks.length + 1), highlightKeyForRow: (row) => `wave-task-${row}` });
            }
            sections.push({ title: "PlannerActivity", rowCount: Math.min(15, this.steeringEvents.length), highlightKeyForRow: (row) => `steer-event-${row}` });
            sections.push({ title: "StatusLine", rowCount: 1, highlightKeyForRow: () => "status-line" });
        }
        // Ensure at least one section
        if (sections.length === 0) {
            sections.push({ title: "Content", rowCount: 1, highlightKeyForRow: () => "content" });
        }
        return sections;
    }
    clampNavState(sections) {
        const nav = this.navState;
        nav.focusSection = Math.min(Math.max(0, nav.focusSection), sections.length - 1);
        const s = sections[nav.focusSection];
        if (s) {
            nav.focusRow = Math.min(Math.max(0, nav.focusRow), Math.max(0, s.rowCount - 1));
        }
    }
    /** Returns the unique highlight key for the currently focused row, used by renderer. */
    getHighlightKey() {
        const sections = this.getSections();
        const nav = this.navState;
        const section = sections[Math.min(nav.focusSection, sections.length - 1)];
        return section?.highlightKeyForRow?.(nav.focusRow);
    }
    clearAskTempFile() {
        if (this.askTempFile) {
            try {
                rmSync(this.askTempFile, { force: true });
            }
            catch { }
            if (askTempDir) {
                try {
                    rmSync(askTempDir, { recursive: true, force: true });
                }
                catch { }
            }
            this.askTempFile = undefined;
            askTempDir = undefined;
        }
    }
    /** Get the currently selected agent's ID for rendering. */
    getSelectedAgentId() { return this.selectedAgentId; }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.lastFrame = "";
        this.setupHotkeys();
        this.resumeInterval();
    }
    setWave(swarm) {
        this.swarm = swarm;
        this.steeringActive = false;
        this.rlGetter = undefined;
        this.lastSeq = 0;
        this.lastCompleted = -1;
    }
    setSteering(rlGetter, ctx) {
        this.swarm = undefined;
        this.steeringActive = true;
        this.steeringStatusLine = "Assessing...";
        this.steeringStartedAt = Date.now();
        this.steeringEvents = [];
        this.steeringContext = ctx;
        this.rlGetter = rlGetter;
    }
    /** Replace the single live status line (ticker heartbeat). */
    updateSteeringStatus(text) { this.steeringStatusLine = text; }
    /** Append a discrete, persistent line to the steering scrollback. */
    appendSteeringEvent(text) {
        this.steeringEvents.push({ time: Date.now(), text });
        if (this.steeringEvents.length > MAX_STEERING_EVENTS)
            this.steeringEvents.shift();
    }
    /** Backwards-compat alias  -- treats input as the current status line. */
    updateText(text) { this.updateSteeringStatus(text); }
    pause() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }
    resume() {
        if (!this.started || this.interval)
            return;
        if (this.isTTY)
            try {
                process.stdout.write("\x1B[?25l");
            }
            catch { }
        this.resumeInterval();
    }
    stop() {
        this.pause();
        if (this.keyHandler) {
            process.stdin.removeListener("data", this.keyHandler);
            this.keyHandler = undefined;
            try {
                process.stdout.write("\x1B[?2004l");
            }
            catch { }
            try {
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
            catch { }
        }
        try {
            process.stdout.write("\x1B[?25h");
        }
        catch { }
        // Clean up ask temp file
        this.clearAskTempFile();
        this.started = false;
    }
    resumeInterval() {
        if (this.interval)
            return;
        if (!this.isTTY) {
            this.interval = setInterval(() => this.plainTick(), 500);
            return;
        }
        try {
            process.stdout.write("\x1B[?25l\x1B[H\x1B[J");
        }
        catch {
            return;
        }
        this.interval = setInterval(() => this.flush(), 250);
    }
    /** Write the full frame to stdout, clamped to terminal height.
     *  Layout: header + content (elastic) + footer + input/ask (fixed).
     *  The content area shrinks so input prompts are never clipped. */
    flush() {
        try {
            const maxRows = (process.stdout.rows || 40) - 1;
            const frame = this.render(maxRows);
            if (frame === this.lastFrame)
                return; // nothing changed
            this.lastFrame = frame;
            process.stdout.write("\x1B[H\x1B[J" + frame);
        }
        catch {
            this.pause();
        }
    }
    render(maxRows) {
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
        // `bottom` always starts with "\n" (renderInputPrompt prefixes, and the panel
        // branch prepends "\n"). Each newline consumes exactly one visual row, so
        // bottomRows == count of newlines — no +1.
        const bottomRows = bottom ? (bottom.match(/\n/g) || []).length : 0;
        const frameBudget = maxRows != null ? maxRows - bottomRows : undefined;
        let frame = "";
        if (this.swarm) {
            frame = renderFrame(this.swarm, this.hasHotkeys(), this.runInfo, this.selectedAgentId, frameBudget, this.panel);
        }
        else if (this.steeringActive) {
            frame = renderSteeringFrame(this.runInfo, {
                statusLine: this.steeringStatusLine,
                events: this.steeringEvents,
                context: this.steeringContext,
                startedAt: this.steeringStartedAt,
            }, this.hasHotkeys(), this.rlGetter, frameBudget, this.panel);
        }
        else {
            return "";
        }
        return frame + bottom;
    }
    /** Read the current value for a settings field from liveConfig/swarm. */
    currentFieldValue(field) {
        const lc = this.liveConfig;
        const s = this.swarm;
        switch (field) {
            case "budget": return String(lc?.remaining ?? "—");
            case "cap": return lc?.usageCap != null ? `${Math.round(lc.usageCap * 100)}%` : "unlimited";
            case "conc": return String(lc?.concurrency ?? "—");
            case "extra": return lc?.extraUsageBudget != null ? `$${lc.extraUsageBudget}` : "unlimited";
            case "worker": return lc?.workerModel ?? s?.model ?? "—";
            case "planner": return lc?.plannerModel ?? "—";
            case "fast": return lc?.fastModel ?? "(none)";
            case "perms": {
                const p = lc?.permissionMode ?? "auto";
                return p === "bypassPermissions" ? "yolo" : p;
            }
            case "pause": return s?.paused ? "paused" : "running";
            default: return "";
        }
    }
    renderInputPrompt() {
        if (this.inputMode === "none")
            return "";
        const rendered = renderSegments(this.inputSegs);
        if (this.inputMode === "settings") {
            const labels = [
                "New budget (remaining sessions)",
                "New usage cap (0-100%, 0=unlimited)",
                "New concurrency (min 1)",
                "Extra usage $ cap (0=stop on overage)",
                "Worker model (for agent tasks)",
                "Planner model (steering/thinking)",
                "Fast model (optional, empty=skip)",
                "Permission mode (auto/yolo/prompt)",
                "Pause/resume workers",
            ];
            const total = SETTINGS_FIELDS.length;
            const field = SETTINGS_FIELDS[this.settingsField % total];
            const label = labels[this.settingsField % total];
            const idx = this.settingsField + 1;
            const currentValue = this.currentFieldValue(field);
            const hint = field === "pause"
                ? chalk.dim(` (Enter to toggle, Tab to skip, Esc to exit)`)
                : chalk.dim(` [${idx}/${total}]  Tab=next  Esc=exit  current: ${chalk.white(currentValue)}`);
            return `\n  ${chalk.cyan("◆")} ${chalk.bold(label)}${hint}\n  ${rendered}\u2588`;
        }
        if (this.inputMode === "steer") {
            return `\n  ${chalk.cyan(">")} ${chalk.bold("Inject next wave")} ${chalk.dim("(Enter to queue, Esc to cancel)")}\n  ${rendered}\u2588`;
        }
        if (this.inputMode === "ask") {
            return `\n  ${chalk.cyan(">")} ${chalk.bold("Ask the planner")} ${chalk.dim("(Enter to send, Esc to cancel)")}\n  ${rendered}\u2588`;
        }
        return "";
    }
    hasHotkeys() {
        return !!this.liveConfig && !!process.stdin.isTTY;
    }
    setupHotkeys() {
        if (!this.liveConfig || !process.stdin.isTTY)
            return;
        try {
            process.stdin.setRawMode(true);
            process.stdin.resume();
        }
        catch {
            return;
        }
        try {
            process.stdout.write("\x1B[?2004h");
        }
        catch { }
        this.keyHandler = (buf) => {
            const chunk = buf.toString();
            let dirty = false;
            for (const seg of splitPaste(chunk)) {
                if (seg.type === "paste") {
                    if (this.handlePaste(seg.text))
                        dirty = true;
                }
                else {
                    if (this.handleTyped(seg.text))
                        dirty = true;
                }
            }
            if (dirty)
                this.flush();
        };
        process.stdin.on("data", this.keyHandler);
    }
    /** Handle a pasted block. Returns true if the frame needs a redraw. */
    handlePaste(text) {
        if (this.inputMode === "settings") {
            const field = SETTINGS_FIELDS[this.settingsField % SETTINGS_FIELDS.length];
            if (NUMERIC_SETTINGS_FIELDS.has(field)) {
                const clean = text.replace(/[^0-9.]/g, "");
                if (clean)
                    appendCharToSegments(this.inputSegs, clean);
                return !!clean;
            }
            if (field !== "pause" && text.length + segmentsToString(this.inputSegs).length <= MAX_INPUT_LEN) {
                appendPasteToSegments(this.inputSegs, text);
                return true;
            }
        }
        if (this.inputMode === "steer" || this.inputMode === "ask") {
            if (segmentsToString(this.inputSegs).length + text.length > MAX_INPUT_LEN)
                return false;
            appendPasteToSegments(this.inputSegs, text);
            return true;
        }
        return false;
    }
    /** Keyboard handler used only while the panel is expanded fullscreen.
     *  Handles scroll + close. Swallows everything else so the normal hotkeys
     *  (s/p/i/?/d/0-9) do not fire while the user is reading. */
    handlePanelKey(s) {
        const bodyRows = Math.max(3, (process.stdout.rows || 40) - 7);
        // CSI sequences: arrows, PgUp/PgDn, Home/End
        if (s.startsWith("\x1B[")) {
            if (s === "\x1B[A") {
                this.panel.scroll("up", bodyRows);
                return true;
            }
            if (s === "\x1B[B") {
                this.panel.scroll("down", bodyRows);
                return true;
            }
            if (s === "\x1B[5~") {
                this.panel.pageScroll("up", bodyRows);
                return true;
            }
            if (s === "\x1B[6~") {
                this.panel.pageScroll("down", bodyRows);
                return true;
            }
            if (s === "\x1B[H" || s === "\x1B[1~") {
                this.panel.scrollToTop();
                return true;
            }
            if (s === "\x1B[F" || s === "\x1B[4~") {
                this.panel.scrollToBottom(bodyRows);
                return true;
            }
            return false; // swallow other CSIs silently
        }
        // Bare ESC: collapse if expanded, close if collapsed
        if (s === "\x1B") {
            if (this.panel.state.expanded) {
                this.panel.collapse();
            }
            else {
                this.panel.close();
            }
            return true;
        }
        // Ctrl-O: toggle (collapse)
        if (s === "\x0F") {
            this.panel.toggle();
            return true;
        }
        // Ctrl-C: keep the usual abort / exit behavior even while expanded
        if (s === "\x03") {
            if (this.swarm && !this.swarm.aborted) {
                this.swarm.abort();
                return true;
            }
            process.exit(0);
        }
        // Vim-style jumps
        if (s === "g") {
            this.panel.scrollToTop();
            return true;
        }
        if (s === "G") {
            this.panel.scrollToBottom(bodyRows);
            return true;
        }
        // Space / j / k as extra scroll conveniences
        if (s === " " || s === "j") {
            this.panel.scroll("down", bodyRows);
            return true;
        }
        if (s === "k") {
            this.panel.scroll("up", bodyRows);
            return true;
        }
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
     *          6. hotkey mode     → s (settings), i (inject), q, ?, d, 0-9, f, r, p
     */
    handleTyped(s) {
        const lc = this.liveConfig;
        // ── 0. Fullscreen panel owns the keyboard ──
        // While the interactive panel is expanded it takes over the screen and
        // steals every key except Esc, Ctrl-O (close), Ctrl-C (abort), and scroll.
        // Hotkeys like s/i/p are intentionally swallowed so the user can
        // read without triggering side effects.
        if (this.panel.state.expanded) {
            return this.handlePanelKey(s);
        }
        // ── 1. Arrow keys: \x1B[A = up, \x1B[B = down, \x1B[C = right, \x1B[D = left ──
        if (s.startsWith("\x1B[")) {
            const dir = s[2];
            if (dir === "A") {
                this.navigate("up");
                return true;
            }
            if (dir === "B") {
                this.navigate("down");
                return true;
            }
            if (dir === "C") {
                this.navigate("right");
                return true;
            }
            if (dir === "D") {
                this.navigate("left");
                return true;
            }
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
        if (s === "\t" && this.inputMode === "settings") {
            const field = SETTINGS_FIELDS[this.settingsField % SETTINGS_FIELDS.length];
            if (field === "pause" && this.swarm) {
                const next = !this.swarm.paused;
                this.swarm.setPaused(next);
                this.liveConfig.paused = next;
                this.liveConfig.dirty = true;
            }
            this.settingsField++;
            this.inputSegs = [];
            if (this.settingsField >= SETTINGS_FIELDS.length)
                this.inputMode = "none";
            return true;
        }
        // ── 4. Settings mode: all mutable fields ──
        if (this.inputMode === "settings") {
            let dirty = false;
            for (const ch of s) {
                if (ch === "\r" || ch === "\n") {
                    const field = SETTINGS_FIELDS[this.settingsField % SETTINGS_FIELDS.length];
                    const raw = segmentsToString(this.inputSegs).trim();
                    if (field === "budget") {
                        const val = parseFloat(raw);
                        if (!isNaN(val) && val > 0) {
                            lc.remaining = Math.round(val);
                            lc.dirty = true;
                            this.swarm?.log(-1, `Budget changed to ${lc.remaining} remaining`);
                        }
                    }
                    else if (field === "cap") {
                        const val = parseFloat(raw);
                        if (!isNaN(val) && val >= 0 && val <= 100) {
                            const frac = val / 100;
                            lc.usageCap = frac > 0 ? frac : undefined;
                            lc.dirty = true;
                            if (this.swarm)
                                this.swarm.usageCap = lc.usageCap;
                            this.swarm?.log(-1, `Usage cap changed to ${val > 0 ? val + "%" : "unlimited"}`);
                        }
                    }
                    else if (field === "conc") {
                        const val = parseFloat(raw);
                        if (!isNaN(val) && val >= 1) {
                            const n = Math.round(val);
                            lc.concurrency = n;
                            lc.dirty = true;
                            this.swarm?.setConcurrency(n);
                        }
                    }
                    else if (field === "extra") {
                        const val = parseFloat(raw);
                        if (!isNaN(val) && val >= 0) {
                            lc.extraUsageBudget = val;
                            lc.dirty = true;
                            this.swarm?.setExtraUsageBudget(val);
                        }
                    }
                    else if (field === "worker" && raw) {
                        lc.workerModel = raw;
                        lc.dirty = true;
                        this.swarm?.setModel(raw);
                    }
                    else if (field === "planner" && raw) {
                        lc.plannerModel = raw;
                        lc.dirty = true;
                    }
                    else if (field === "fast") {
                        lc.fastModel = raw || undefined;
                        lc.dirty = true;
                    }
                    else if (field === "perms" && raw) {
                        const m = raw.toLowerCase();
                        const mode = m.startsWith("yolo") || m.startsWith("bypass") ? "bypassPermissions"
                            : m.startsWith("prompt") || m === "default" ? "default" : "auto";
                        lc.permissionMode = mode;
                        lc.dirty = true;
                        this.swarm?.setPermissionMode(mode);
                    }
                    else if (field === "pause" && this.swarm) {
                        const next = !this.swarm.paused;
                        this.swarm.setPaused(next);
                        lc.paused = next;
                        lc.dirty = true;
                    }
                    this.settingsField++;
                    if (this.settingsField >= SETTINGS_FIELDS.length)
                        this.inputMode = "none";
                    this.inputSegs = [];
                    return true;
                }
                if (ch === "\x03") {
                    this.inputMode = "none";
                    this.inputSegs = [];
                    return true;
                }
                if (ch === "\x7F") {
                    backspaceSegments(this.inputSegs);
                    dirty = true;
                    continue;
                }
                const field = SETTINGS_FIELDS[this.settingsField % SETTINGS_FIELDS.length];
                if (NUMERIC_SETTINGS_FIELDS.has(field)) {
                    if (/^[0-9.]$/.test(ch)) {
                        appendCharToSegments(this.inputSegs, ch);
                        dirty = true;
                    }
                }
                else if (field !== "pause") {
                    const code = ch.charCodeAt(0);
                    if (code >= 0x20 && code <= 0x7E) {
                        appendCharToSegments(this.inputSegs, ch);
                        dirty = true;
                    }
                }
            }
            return dirty;
        }
        // ── 5. Input mode: steer / ask ──
        if (this.inputMode === "steer" || this.inputMode === "ask") {
            let dirty = false;
            // Iterate by code point (Array.from) so emoji/surrogate pairs stay intact.
            const chars = Array.from(s);
            for (let ci = 0; ci < chars.length; ci++) {
                const ch = chars[ci];
                if (ch === "\r" || ch === "\n") {
                    const text = segmentsToString(this.inputSegs).trim();
                    const wasAsk = this.inputMode === "ask";
                    this.inputMode = "none";
                    this.inputSegs = [];
                    if (text) {
                        if (wasAsk)
                            this.onAsk?.(text);
                        else
                            this.onSteer?.(text);
                    }
                    return true;
                }
                if (ch === "\x03") {
                    this.inputMode = "none";
                    this.inputSegs = [];
                    return true;
                }
                // ESC: if another byte follows it's part of an Alt+key sequence — skip both.
                // Standalone ESC (no following byte) cancels input mode.
                if (ch === "\x1B") {
                    if (ci + 1 < chars.length) {
                        ci++;
                        continue;
                    }
                    this.inputMode = "none";
                    this.inputSegs = [];
                    return true;
                }
                if (ch === "\x7F" || ch === "\b") {
                    backspaceSegments(this.inputSegs);
                    dirty = true;
                    continue;
                }
                const code = ch.codePointAt(0) ?? 0;
                // Reject C0/C1 control characters; accept everything else including Unicode.
                if (code < 0x20)
                    continue;
                if (code >= 0x7F && code < 0xA0)
                    continue;
                if (segmentsToString(this.inputSegs).length + ch.length <= MAX_INPUT_LEN) {
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
                try {
                    execSync(`open -R ${JSON.stringify(this.askTempFile)}`);
                }
                catch { }
            }
            return true;
        }
        // Ctrl+C
        if (s === "\x03") {
            if (this.swarm && !this.swarm.aborted) {
                this.swarm.abort();
            }
            else {
                process.exit(0);
            }
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
        if (s.length !== 1)
            return false;
        const key = s[0];
        const code = key.charCodeAt(0);
        if (code < 0x20 || code > 0x7E)
            return false;
        if (key === "s" || key === "S") {
            if (!this.swarm)
                return false;
            this.inputMode = "settings";
            this.settingsField = 0;
            this.inputSegs = [];
            return true;
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
        if ((key === "i" || key === "I") && this.onSteer) {
            this.inputMode = "steer";
            this.inputSegs = [];
            return true;
        }
        if (key === "?" && this.onAsk && this.swarm && !this.askBusy) {
            if (this.askState && !this.askState.streaming) {
                this.askState = undefined;
                this.clearAskTempFile();
                return true;
            }
            this.inputMode = "ask";
            this.inputSegs = [];
            return true;
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
            if (n < running.length) {
                this.selectAgent(running[n].id);
                return true;
            }
        }
        if (key === "q" || key === "Q") {
            if (this.swarm) {
                if (this.swarm.aborted)
                    process.exit(0);
                this.swarm.abort();
            }
            else {
                process.exit(0);
            }
        }
        return false;
    }
    plainTick() {
        if (!this.swarm)
            return;
        const swarm = this.swarm;
        const write = (line) => { try {
            process.stdout.write(line + "\n");
        }
        catch { } };
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
