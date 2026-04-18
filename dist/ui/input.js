import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Keyboard + input-overlay layer.
//
// `useInput` dispatches typed characters and special keys. The hotkey table
// here is the executable mirror of the canonical footer contract:
//   ? ask · i steer · d debrief · p pause · s settings · f fallback ·
//   r skip-rl · q quit · arrows+0-9 for agent detail nav
//
// Text-entry overlays (steer, ask, settings) are *not* separate phases — they
// capture typed chars, show a minimal hint in the footer (handled by
// footer.tsx), and dispatch on Enter/Esc.
import { useState, useSyncExternalStore } from "react";
import { Text, Box, useInput } from "ink";
import chalk from "chalk";
import { SETTINGS_FIELDS, SETTINGS_LABELS, NUMERIC_SETTINGS_FIELDS, applySettingEdit, readSettingValue, } from "./settings.js";
export const MAX_INPUT_LEN = 600;
export function InputLayer({ store, callbacks, onToast }) {
    const [buffer, setBuffer] = useState("");
    const [settingsField, setSettingsField] = useState(0);
    useInput((raw, key) => {
        const state = store.get();
        const mode = state.input.mode;
        const swarm = state.swarm;
        const lc = state.liveConfig;
        // ── Text-entry modes ──
        if (mode !== "none") {
            // Esc bails
            if (key.escape) {
                setBuffer("");
                setSettingsField(0);
                store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
                return;
            }
            if (key.return) {
                const text = buffer.trim();
                if (mode === "steer" && text)
                    callbacks.onSteer(text);
                else if (mode === "ask" && text)
                    callbacks.onAsk(text);
                else if (mode === "settings") {
                    const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
                    if (lc)
                        applySettingEdit(field, text, lc, swarm);
                    callbacks.settingsTick();
                    const next = settingsField + 1;
                    setBuffer("");
                    if (next >= SETTINGS_FIELDS.length) {
                        setSettingsField(0);
                        store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
                    }
                    else {
                        setSettingsField(next);
                        store.patch({ input: { mode: "settings", buffer: "", settingsField: next } });
                    }
                    return;
                }
                setBuffer("");
                setSettingsField(0);
                store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
                return;
            }
            if (key.tab && mode === "settings") {
                const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
                if (field === "pause" && swarm && lc) {
                    const next = !swarm.paused;
                    swarm.setPaused(next);
                    lc.paused = next;
                    lc.dirty = true;
                    callbacks.settingsTick();
                }
                const next = settingsField + 1;
                setBuffer("");
                if (next >= SETTINGS_FIELDS.length) {
                    setSettingsField(0);
                    store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
                }
                else {
                    setSettingsField(next);
                    store.patch({ input: { mode: "settings", buffer: "", settingsField: next } });
                }
                return;
            }
            if (key.backspace || key.delete) {
                const next = buffer.slice(0, -1);
                setBuffer(next);
                store.patch({ input: { ...state.input, buffer: next } });
                return;
            }
            // Typed char(s) — raw is the string for this event
            if (raw && raw.length > 0) {
                let text = raw;
                if (mode === "settings") {
                    const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
                    if (NUMERIC_SETTINGS_FIELDS.has(field))
                        text = text.replace(/[^0-9.]/g, "");
                    if (field === "pause")
                        return;
                }
                if (!text)
                    return;
                const next = (buffer + text).slice(0, MAX_INPUT_LEN);
                setBuffer(next);
                store.patch({ input: { ...state.input, buffer: next } });
            }
            return;
        }
        // ── Hotkey mode ──
        // Arrow keys — agent detail cycle
        if (key.rightArrow || key.downArrow) {
            callbacks.cycleAgent(1);
            return;
        }
        if (key.upArrow) {
            callbacks.cycleAgent(-1);
            return;
        }
        if (key.leftArrow) {
            callbacks.clearSelectedAgent();
            return;
        }
        // Escape in hotkey mode — clear agent selection or dismiss answered ask
        if (key.escape) {
            if (state.selectedAgentId != null) {
                callbacks.clearSelectedAgent();
                return;
            }
            if (state.ask && !state.ask.streaming) {
                callbacks.clearAsk();
                return;
            }
            return;
        }
        // Ctrl-C: abort swarm or exit
        if (key.ctrl && raw === "c") {
            if (swarm && !swarm.aborted) {
                swarm.abort();
                return;
            }
            process.exit(0);
        }
        // Enter in hotkey mode — reveal ask answer file in Finder if we have one
        if (key.return) {
            if (state.askTempFileAvailable)
                callbacks.openAskTempFile();
            return;
        }
        if (!raw || raw.length !== 1)
            return;
        const code = raw.charCodeAt(0);
        if (code < 0x20 || code > 0x7E)
            return;
        const toast = (msg) => onToast(msg);
        switch (raw.toLowerCase()) {
            case "?":
                if (!state.hasOnAsk)
                    return toast("Ask not wired for this run");
                if (state.askBusy || state.ask?.streaming)
                    return toast("Ask already in flight");
                if (state.ask && !state.ask.streaming) {
                    callbacks.clearAsk();
                    return;
                }
                store.patch({ input: { mode: "ask", buffer: "", settingsField: 0 } });
                setBuffer("");
                return;
            case "i":
                if (!state.hasOnSteer)
                    return toast("Steering not wired for this run");
                store.patch({ input: { mode: "steer", buffer: "", settingsField: 0 } });
                setBuffer("");
                return;
            case "d":
                // Show latest debrief entry in the overlay; if nothing yet, toast.
                if (state.debrief)
                    return; // already visible
                if (state.debriefHistory.length > 0) {
                    const last = state.debriefHistory[state.debriefHistory.length - 1];
                    store.patch({ debrief: { text: last.text, label: last.label } });
                    return;
                }
                toast("No debrief yet");
                return;
            case "p":
                if (!swarm || !lc)
                    return toast("No live wave to pause");
                swarm.setPaused(!swarm.paused);
                lc.paused = swarm.paused;
                lc.dirty = true;
                callbacks.settingsTick();
                return;
            case "s":
                if (!lc)
                    return toast("Settings unavailable");
                setSettingsField(0);
                setBuffer("");
                store.patch({ input: { mode: "settings", buffer: "", settingsField: 0 } });
                return;
            case "f":
                if (!swarm || swarm.failed <= 0 || swarm.active <= 0)
                    return toast("No failed branches to fall back from");
                swarm.requeueFailed();
                return;
            case "r":
                if (!swarm || swarm.rateLimitPaused <= 0)
                    return toast("Not paused for rate-limit");
                swarm.retryRateLimitNow();
                return;
            case "q":
                // Second press with the current swarm already aborted = hard exit.
                if (swarm?.aborted)
                    process.exit(0);
                // Always request quit: flips the runner's `stopping` flag so the wave
                // loop breaks instead of advancing to steering / post-run review.
                callbacks.requestQuit();
                return;
        }
        if (/^[0-9]$/.test(raw) && swarm) {
            const n = parseInt(raw, 10);
            const running = swarm.agents.filter(a => a.status === "running");
            if (n < running.length)
                callbacks.selectAgent(running[n].id);
        }
    });
    // Render the active text-entry prompt under the footer hint.
    const state = useSyncExternalStore(store.subscribe, store.get, store.get);
    if (state.input.mode === "none")
        return null;
    // Caret pulses with the 1 Hz tick — visible on even ticks, hidden on odd.
    const caret = state.tick % 2 === 0 ? chalk.cyan("\u2588") : " ";
    return _jsx(InputPrompt, { mode: state.input.mode, buffer: buffer, settingsField: settingsField, state: state, caret: caret });
}
function InputPrompt({ mode, buffer, settingsField, state, caret, }) {
    if (mode === "settings") {
        const total = SETTINGS_FIELDS.length;
        const field = SETTINGS_FIELDS[settingsField % total];
        const label = SETTINGS_LABELS[field];
        const current = readSettingValue(field, state.liveConfig, state.swarm);
        const hint = field === "pause"
            ? chalk.dim(` (Enter toggle, Tab skip, Esc exit)`)
            : chalk.dim(` [${settingsField + 1}/${total}]  Tab next \u00b7 Esc exit \u00b7 current: ${chalk.white(current)}`);
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: ["  ", chalk.cyan("\u25C6"), " ", chalk.bold(label), hint] }), _jsxs(Text, { children: ["  ", buffer, caret] })] }));
    }
    const title = mode === "steer" ? "Inject next wave" : "Ask the planner";
    const action = mode === "steer" ? "queue" : "send";
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: ["  ", chalk.cyan(">"), " ", chalk.bold(title), " ", chalk.dim(`(Enter to ${action}, Esc to cancel)`)] }), _jsxs(Text, { children: ["  ", buffer, caret] })] }));
}
