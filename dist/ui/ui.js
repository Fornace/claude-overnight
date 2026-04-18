import { jsx as _jsx } from "react/jsx-runtime";
import { render as inkRender } from "ink";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { UiStore, makeInitialState } from "./store.js";
import { App } from "./shell.js";
const MAX_STEERING_EVENTS = 60;
const MAX_ASK_LINES = 40;
const MAX_DEBRIEF_HISTORY = 20;
function askDisplayCap() {
    return Math.max(3, Math.min(MAX_ASK_LINES, (process.stdout.rows || 40) - 20));
}
let askTempDir;
export class RunDisplay {
    runInfo;
    store;
    ink;
    started = false;
    isTTY;
    askTempFile;
    // Plain-mode (non-TTY) tracking
    plainInterval;
    lastSeq = 0;
    lastCompleted = -1;
    onSteer;
    onAsk;
    constructor(runInfo, liveConfig, callbacks) {
        this.runInfo = runInfo;
        this.onSteer = callbacks?.onSteer;
        this.onAsk = callbacks?.onAsk;
        this.isTTY = !!process.stdout.isTTY;
        this.store = new UiStore(makeInitialState(runInfo, liveConfig, {
            hasOnSteer: !!this.onSteer,
            hasOnAsk: !!this.onAsk,
        }));
    }
    // ── Lifecycle ──
    start() {
        if (this.started)
            return;
        this.started = true;
        if (this.isTTY) {
            const callbacks = {
                onSteer: (t) => this.onSteer?.(t),
                onAsk: (t) => this.onAsk?.(t),
                clearAsk: () => this.clearAskState(),
                openAskTempFile: () => this.openAskTempFile(),
                cycleAgent: (dir) => this.cycleSelectedAgent(dir),
                selectAgent: (id) => this.selectAgent(id),
                clearSelectedAgent: () => this.clearSelectedAgent(),
                settingsTick: () => this.nudge(),
            };
            this.ink = inkRender(_jsx(App, { store: this.store, callbacks: callbacks }));
        }
        else {
            this.plainInterval = setInterval(() => this.plainTick(), 500);
        }
    }
    pause() {
        // Ink mode: unmount to free stdout so a string block (summary, prompts)
        // can be printed in the gap. Resume remounts fresh state from the store.
        if (this.ink) {
            try {
                this.ink.unmount();
            }
            catch { }
            this.ink = undefined;
        }
        if (this.plainInterval) {
            clearInterval(this.plainInterval);
            this.plainInterval = undefined;
        }
    }
    resume() {
        if (!this.started)
            return;
        if (this.isTTY && !this.ink) {
            const callbacks = {
                onSteer: (t) => this.onSteer?.(t),
                onAsk: (t) => this.onAsk?.(t),
                clearAsk: () => this.clearAskState(),
                openAskTempFile: () => this.openAskTempFile(),
                cycleAgent: (dir) => this.cycleSelectedAgent(dir),
                selectAgent: (id) => this.selectAgent(id),
                clearSelectedAgent: () => this.clearSelectedAgent(),
                settingsTick: () => this.nudge(),
            };
            this.ink = inkRender(_jsx(App, { store: this.store, callbacks: callbacks }));
            return;
        }
        if (!this.isTTY && !this.plainInterval) {
            this.plainInterval = setInterval(() => this.plainTick(), 500);
        }
    }
    stop() {
        this.pause();
        this.clearAskTempFile();
        this.started = false;
    }
    // ── Phase updates ──
    setWave(swarm) {
        this.lastSeq = 0;
        this.lastCompleted = -1;
        this.store.patch({
            phase: "run",
            swarm,
            rlGetter: undefined,
            steeringContext: undefined,
        });
    }
    setSteering(rlGetter, ctx) {
        this.store.patch({
            phase: "steering",
            swarm: undefined,
            selectedAgentId: undefined,
            rlGetter,
            steeringContext: ctx,
            steeringStatusLine: "Assessing...",
            steeringStartedAt: Date.now(),
            steeringEvents: [],
        });
    }
    updateSteeringStatus(text) {
        this.store.patch({ steeringStatusLine: text });
    }
    appendSteeringEvent(text) {
        const cur = this.store.get().steeringEvents;
        const next = [...cur, { time: Date.now(), text }];
        if (next.length > MAX_STEERING_EVENTS)
            next.shift();
        this.store.patch({ steeringEvents: next });
    }
    /** Backwards-compat alias. */
    updateText(text) { this.updateSteeringStatus(text); }
    // ── Selection ──
    selectAgent(id) {
        const swarm = this.store.get().swarm;
        if (!swarm)
            return;
        const a = swarm.agents.find(ag => ag.id === id);
        if (a && a.status === "running")
            this.store.patch({ selectedAgentId: id });
    }
    clearSelectedAgent() { this.store.patch({ selectedAgentId: undefined }); }
    cycleSelectedAgent(direction = 1) {
        const { swarm, selectedAgentId } = this.store.get();
        if (!swarm)
            return;
        const running = swarm.agents.filter(a => a.status === "running");
        if (running.length === 0) {
            this.store.patch({ selectedAgentId: undefined });
            return;
        }
        if (selectedAgentId == null) {
            const pick = direction > 0 ? running[0] : running[running.length - 1];
            this.store.patch({ selectedAgentId: pick.id });
            return;
        }
        const idx = running.findIndex(a => a.id === selectedAgentId);
        const next = (idx + direction + running.length) % running.length;
        this.store.patch({ selectedAgentId: running[next].id });
    }
    // ── Ask ──
    setAsk(state) {
        this.clearAskTempFile();
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
        }
        this.store.patch({ ask: state, askTempFileAvailable: !!this.askTempFile });
    }
    setAskBusy(busy) { this.store.patch({ askBusy: busy }); }
    clearAskState() {
        this.clearAskTempFile();
        this.store.patch({ ask: undefined, askTempFileAvailable: false });
    }
    openAskTempFile() {
        if (!this.askTempFile)
            return;
        try {
            execSync(`open -R ${JSON.stringify(this.askTempFile)}`);
        }
        catch { }
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
    // ── Debrief ──
    setDebrief(text, label) {
        if (!text) {
            this.store.patch({ debrief: undefined });
            return;
        }
        const entry = { label: label ?? "Debrief", text, time: Date.now() };
        const history = this.store.get().debriefHistory.slice();
        if (label && !text.startsWith("Summarizing")) {
            history.push(entry);
            while (history.length > MAX_DEBRIEF_HISTORY)
                history.shift();
        }
        this.store.patch({ debrief: { text, label }, debriefHistory: history });
    }
    // ── Internal ──
    /** Force a re-render by bumping the tick — used after we mutate a swarm /
     *  liveConfig in-place and want the UI to reflect it immediately. */
    nudge() {
        this.store.patch({ tick: this.store.get().tick + 1 });
    }
    plainTick() {
        const swarm = this.store.get().swarm;
        if (!swarm)
            return;
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
