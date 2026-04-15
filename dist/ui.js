import chalk from "chalk";
import { renderFrame, renderSteeringFrame } from "./render.js";
import { splitPaste, segmentsToString, renderSegments, appendCharToSegments, appendPasteToSegments, backspaceSegments, } from "./cli.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
const MAX_STEERING_EVENTS = 60;
const MAX_INPUT_LEN = 600;
const MAX_ASK_LINES = 40;
let askTempDir;
export class RunDisplay {
    runInfo;
    liveConfig;
    swarm;
    steeringActive = false;
    steeringStatusLine = "Assessing...";
    steeringEvents = [];
    steeringContext;
    rlGetter;
    interval;
    keyHandler;
    inputMode = "none";
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
    onSteer;
    onAsk;
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
            if (lines.length > MAX_ASK_LINES) {
                try {
                    askTempDir = mkdtempSync(join(tmpdir(), "overnight-ask-"));
                    this.askTempFile = join(askTempDir, "answer.txt");
                    writeFileSync(this.askTempFile, state.answer, "utf8");
                }
                catch { }
            }
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
    /** Write the full frame to stdout, clamped to terminal height. */
    flush() {
        try {
            const maxRows = (process.stdout.rows || 40) - 1;
            const frame = this.render();
            const lines = frame.split("\n");
            process.stdout.write("\x1B[H\x1B[J");
            process.stdout.write(lines.length > maxRows ? lines.slice(0, maxRows).join("\n") : frame);
        }
        catch {
            this.pause();
        }
    }
    render() {
        let frame = "";
        if (this.swarm) {
            frame = renderFrame(this.swarm, this.hasHotkeys(), this.runInfo, this.selectedAgentId);
        }
        else if (this.steeringActive) {
            frame = renderSteeringFrame(this.runInfo, {
                statusLine: this.steeringStatusLine,
                events: this.steeringEvents,
                context: this.steeringContext,
            }, this.hasHotkeys(), this.rlGetter);
        }
        else {
            return "";
        }
        frame += this.renderInputPrompt();
        frame += this.renderAskPanel();
        return frame;
    }
    renderInputPrompt() {
        if (this.inputMode === "none")
            return "";
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
    renderAskPanel() {
        const a = this.askState;
        if (!a)
            return "";
        const out = ["", chalk.gray("  \u2500\u2500\u2500 Ask " + "\u2500".repeat(40))];
        out.push(`  ${chalk.bold.cyan("Q:")} ${a.question}`);
        if (a.error) {
            out.push(`  ${chalk.red("A:")} ${chalk.red(a.error)}`);
        }
        else if (a.streaming) {
            out.push(`  ${chalk.dim("A: " + (a.answer || "thinking..."))}`);
        }
        else {
            const allLines = a.answer.split("\n");
            const showLines = allLines.slice(0, MAX_ASK_LINES);
            out.push(`  ${chalk.bold.green("A:")} ${showLines[0] || ""}`);
            for (const ln of showLines.slice(1))
                out.push(`     ${ln}`);
            if (allLines.length > MAX_ASK_LINES) {
                const overflow = allLines.length - MAX_ASK_LINES;
                out.push(chalk.dim(`     \u2026 + ${overflow} more lines`));
                if (this.askTempFile) {
                    out.push(chalk.dim("  \u23CE Enter to reveal full answer in Finder"));
                }
            }
        }
        return "\n" + out.join("\n");
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
        if (this.inputMode === "budget" || this.inputMode === "threshold" || this.inputMode === "concurrency" || this.inputMode === "extra") {
            const clean = text.replace(/[^0-9.]/g, "");
            if (clean)
                appendCharToSegments(this.inputSegs, clean);
            return !!clean;
        }
        if (this.inputMode === "steer" || this.inputMode === "ask") {
            if (segmentsToString(this.inputSegs).length + text.length > MAX_INPUT_LEN)
                return false;
            appendPasteToSegments(this.inputSegs, text);
            return true;
        }
        return false;
    }
    /** Handle a typed (non-pasted) chunk. Returns true if the frame needs a redraw.
     *
     * Demux pipeline  -- routes arrow keys and ESC BEFORE hotkey matching:
     *   Raw stdin chunk → splitPaste
     *     ├─ paste → handlePaste (existing, fine)
     *     └─ typed → demux
     *          ├─ ESC + [A/B/C/D  → this.navigate("up"/"down"/"right"/"left")
     *          ├─ ESC             → cancel input / close detail / dismiss panel
     *          ├─ Enter           → submit / reveal / select
     *          ├─ Ctrl+C          → abort
     *          ├─ Backspace       → delete
     *          └─ printable       → hotkey matching (b, t, c, e, p, s, q, ?, d, 0-9)
     */
    handleTyped(s) {
        const lc = this.liveConfig;
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
        // ── 2. Standalone ESC ──
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
        // ── 3. Input mode: budget / threshold / concurrency / extra ──
        if (this.inputMode === "budget" || this.inputMode === "threshold" || this.inputMode === "concurrency" || this.inputMode === "extra") {
            let dirty = false;
            for (const ch of s) {
                if (ch === "\r" || ch === "\n") {
                    const val = parseFloat(segmentsToString(this.inputSegs));
                    if (this.inputMode === "budget" && !isNaN(val) && val > 0) {
                        lc.remaining = Math.round(val);
                        lc.dirty = true;
                        this.swarm?.log(-1, `Budget changed to ${lc.remaining} remaining`);
                    }
                    else if (this.inputMode === "threshold" && !isNaN(val) && val >= 0 && val <= 100) {
                        const frac = val / 100;
                        lc.usageCap = frac > 0 ? frac : undefined;
                        lc.dirty = true;
                        if (this.swarm)
                            this.swarm.usageCap = lc.usageCap;
                        this.swarm?.log(-1, `Usage cap changed to ${val > 0 ? val + "%" : "unlimited"}`);
                    }
                    else if (this.inputMode === "concurrency" && !isNaN(val) && val >= 1) {
                        const n = Math.round(val);
                        lc.concurrency = n;
                        lc.dirty = true;
                        this.swarm?.setConcurrency(n);
                    }
                    else if (this.inputMode === "extra" && !isNaN(val) && val >= 0) {
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
                if (ch === "\x7F") {
                    backspaceSegments(this.inputSegs);
                    dirty = true;
                    continue;
                }
                if (/^[0-9.]$/.test(ch)) {
                    appendCharToSegments(this.inputSegs, ch);
                    dirty = true;
                }
            }
            return dirty;
        }
        // ── 4. Input mode: steer / ask ──
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
                // ESC cancels input mode (no ANSI-byte consumption loop  -- arrows arrive
                // as "\x1B[A" in a single call and are caught by step 1 above)
                if (ch === "\x1B") {
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
                if (code < 0x20)
                    continue;
                if (code >= 0x7F && code < 0xA0)
                    continue;
                if (code >= 0x20 && code <= 0x7E && segmentsToString(this.inputSegs).length < MAX_INPUT_LEN) {
                    appendCharToSegments(this.inputSegs, ch);
                    dirty = true;
                }
            }
            return dirty;
        }
        // ── 5. Hotkey mode ──
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
        // Only single printable ASCII characters reach hotkey matching
        if (s.length !== 1)
            return false;
        const key = s[0];
        const code = key.charCodeAt(0);
        if (code < 0x20 || code > 0x7E)
            return false;
        if (key === "b" || key === "B") {
            this.inputMode = "budget";
            this.inputSegs = [];
            return true;
        }
        if (key === "t" || key === "T") {
            if (this.swarm) {
                this.inputMode = "threshold";
                this.inputSegs = [];
                return true;
            }
            return false;
        }
        if (key === "c" || key === "C") {
            if (this.swarm) {
                this.inputMode = "concurrency";
                this.inputSegs = [];
                return true;
            }
            return false;
        }
        if (key === "e" || key === "E") {
            if (this.swarm) {
                this.inputMode = "extra";
                this.inputSegs = [];
                return true;
            }
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
            this.inputMode = "steer";
            this.inputSegs = [];
            return true;
        }
        if (key === "?" && this.onAsk && this.swarm && !this.askBusy) {
            if (this.askState && !this.askState.streaming) {
                this.askState = undefined;
                this.clearAskTempFile();
                return false;
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
