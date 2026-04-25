import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Keyboard + input-overlay layer.
//
// Two input paths, chosen by `state.input.mode`:
//
//   - mode === "none"  → Ink's `useInput` dispatches hotkeys (?, i, d, p, s, …)
//   - mode !== "none"  → a raw stdin tap using the shared parser in
//                        `./raw-input.ts`. Ink's useInput is disabled while
//                        the overlay is open so paste never gets fragmented
//                        into per-char keypress events (which used to fire
//                        `key.return` on any `\n` in the paste and submit).
//
// The shared parser is the same one `cli.ts` `ask()` uses, so preflight
// prompts and in-run overlays behave identically: typed Enter = a stdin chunk
// that's exactly "\r"/"\n"/"\r\n"; anything else with embedded newlines is a
// paste, not a submit.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, Box, useInput, useStdin } from "ink";
import chalk from "chalk";
import { visibleLen, wrap } from "./primitives.js";
import { SETTINGS_FIELDS, SETTINGS_LABELS, NUMERIC_SETTINGS_FIELDS, applySettingEdit, readSettingValue, } from "./settings.js";
import { parseChunk, setBracketedPaste, deleteWordBackward as rawDeleteWordBackward } from "./raw-input.js";
export const MAX_INPUT_LEN = 600;
// Kept for backwards compatibility with existing tests. Matches C0, DEL, C1.
export const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/g;
/** Strip control characters from typed raw input. Exported for tests. */
export function sanitizeTyped(raw) {
    return raw.replace(CONTROL_CHAR_RE, "");
}
/** Delete the previous word including any trailing whitespace, readline-style.
 *  Exported for tests. */
export const deleteWordBackward = rawDeleteWordBackward;
export function InputLayer({ store, callbacks, onToast }) {
    const [buffer, setBuffer] = useState("");
    const [settingsField, setSettingsField] = useState(0);
    const state = useSyncExternalStore(store.subscribe, store.get, store.get);
    const mode = state.input.mode;
    const textEntry = mode !== "none";
    // ── Text-entry path: raw stdin tap via the shared parser ──
    const { stdin, setRawMode, isRawModeSupported } = useStdin();
    useEffect(() => {
        if (!textEntry || !stdin || !isRawModeSupported)
            return;
        setRawMode(true);
        setBracketedPaste(process.stdout, true);
        // Snapshot the overlay-relevant state locally; callbacks always pull the
        // latest live state via `store.get()` on each event.
        const onData = (buf) => {
            const cur = store.get();
            const m = cur.input.mode;
            if (m === "none")
                return;
            const swarm = cur.swarm;
            const lc = cur.liveConfig;
            const closeOverlay = () => {
                setBuffer("");
                setSettingsField(0);
                store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
            };
            const advanceSettings = () => {
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
            };
            for (const ev of parseChunk(buf.toString())) {
                switch (ev.type) {
                    case "cancel":
                        closeOverlay();
                        return;
                    case "interrupt":
                        // Treat ^C inside overlay as cancel, not process exit.
                        closeOverlay();
                        return;
                    case "submit": {
                        const text = buffer.trim();
                        if (m === "steer" && text)
                            callbacks.onSteer(text);
                        else if (m === "ask" && text)
                            callbacks.onAsk(text);
                        else if (m === "settings") {
                            const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
                            if (lc)
                                applySettingEdit(field, text, lc, swarm);
                            callbacks.settingsTick();
                            advanceSettings();
                            return;
                        }
                        closeOverlay();
                        return;
                    }
                    case "tab":
                        if (m === "settings") {
                            const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
                            if (field === "pause" && swarm && lc) {
                                const next = !swarm.paused;
                                swarm.setPaused(next);
                                lc.paused = next;
                                lc.dirty = true;
                                callbacks.settingsTick();
                            }
                            advanceSettings();
                        }
                        break;
                    case "backspace":
                        setBuffer((prev) => {
                            const next = prev.slice(0, -1);
                            store.patch({ input: { ...store.get().input, buffer: next } });
                            return next;
                        });
                        break;
                    case "word-delete":
                        setBuffer((prev) => {
                            const next = rawDeleteWordBackward(prev);
                            store.patch({ input: { ...store.get().input, buffer: next } });
                            return next;
                        });
                        break;
                    case "clear-line":
                        if (m !== "settings") {
                            setBuffer("");
                            store.patch({ input: { ...store.get().input, buffer: "" } });
                        }
                        break;
                    case "nav":
                        // Navigation keys are a no-op inside the overlay. Used to leak
                        // as stray letters because cmd+→ on macOS sends ctrl+e.
                        break;
                    case "char":
                    case "paste": {
                        let text = ev.type === "paste" ? ev.text.replace(/\r\n?/g, "\n") : ev.text;
                        // Settings mode is single-line and numeric fields are digits-only.
                        if (m === "settings") {
                            const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
                            if (field === "pause")
                                break;
                            if (NUMERIC_SETTINGS_FIELDS.has(field))
                                text = text.replace(/[^0-9.]/g, "");
                            text = text.replace(/\n/g, " ");
                        }
                        if (!text)
                            break;
                        setBuffer((prev) => {
                            const next = (prev + text).slice(0, MAX_INPUT_LEN);
                            store.patch({ input: { ...store.get().input, buffer: next } });
                            return next;
                        });
                        break;
                    }
                }
            }
        };
        stdin.on("data", onData);
        return () => {
            stdin.off("data", onData);
            setBracketedPaste(process.stdout, false);
        };
    }, [textEntry, stdin, setRawMode, isRawModeSupported, buffer, settingsField, store, callbacks]);
    // ── Hotkey path: Ink's useInput, only active when no overlay is open ──
    useInput((raw, key) => {
        const s = store.get();
        const swarm = s.swarm;
        const lc = s.liveConfig;
        if (key.rightArrow || key.downArrow) {
            callbacks.cycleAgent(1);
            const nextId = store.get().selectedAgentId;
            if (nextId != null && s.viewMode.startsWith("stream:agent-")) {
                store.patch({ viewMode: `stream:agent-${nextId}` });
            }
            return;
        }
        if (key.upArrow) {
            callbacks.cycleAgent(-1);
            const nextId = store.get().selectedAgentId;
            if (nextId != null && s.viewMode.startsWith("stream:agent-")) {
                store.patch({ viewMode: `stream:agent-${nextId}` });
            }
            return;
        }
        if (key.leftArrow) {
            callbacks.clearSelectedAgent();
            if (s.viewMode.startsWith("stream:agent-"))
                store.patch({ viewMode: "events" });
            return;
        }
        if (key.escape) {
            if (s.selectedAgentId != null) {
                callbacks.clearSelectedAgent();
                if (s.viewMode.startsWith("stream:agent-"))
                    store.patch({ viewMode: "events" });
                return;
            }
            if (s.viewMode !== "events") {
                store.patch({ viewMode: "events" });
                return;
            }
            if (s.ask && !s.ask.streaming) {
                callbacks.clearAsk();
                return;
            }
            return;
        }
        if (key.ctrl && raw === "c") {
            if (swarm && !swarm.aborted) {
                swarm.abort();
                return;
            }
            process.exit(0);
        }
        if (key.return) {
            if (s.askTempFileAvailable)
                callbacks.openAskTempFile();
            return;
        }
        if (key.tab) {
            const modes = ["stream:planner", "stream:steerer", "stream:verifier"];
            const current = s.viewMode;
            const idx = modes.indexOf(current);
            const next = modes[(idx + 1) % modes.length];
            store.patch({ viewMode: next });
            return;
        }
        if (!raw || raw.length !== 1)
            return;
        const code = raw.charCodeAt(0);
        if (code !== 9 && (code < 0x20 || code > 0x7E))
            return;
        if (key.ctrl || key.meta)
            return;
        const toast = (msg) => onToast(msg);
        switch (raw.toLowerCase()) {
            case "?":
                if (!s.hasOnAsk)
                    return toast("Ask not wired for this run");
                if (s.askBusy || s.ask?.streaming)
                    return toast("Ask already in flight");
                if (s.ask && !s.ask.streaming) {
                    callbacks.clearAsk();
                    return;
                }
                store.patch({ input: { mode: "ask", buffer: "", settingsField: 0 } });
                setBuffer("");
                return;
            case "i":
                if (!s.hasOnSteer)
                    return toast("Steering not wired for this run");
                store.patch({ input: { mode: "steer", buffer: "", settingsField: 0 } });
                setBuffer("");
                return;
            case "d":
                if (s.debrief)
                    return;
                if (s.debriefHistory.length > 0) {
                    const last = s.debriefHistory[s.debriefHistory.length - 1];
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
                if (swarm?.aborted)
                    process.exit(0);
                callbacks.requestQuit();
                return;
        }
        if (/^[0-9]$/.test(raw) && swarm) {
            const n = parseInt(raw, 10);
            const running = swarm.agents.filter(a => a.status === "running");
            if (n < running.length) {
                const id = running[n].id;
                callbacks.selectAgent(id);
                store.patch({ viewMode: `stream:agent-${id}` });
            }
        }
    }, { isActive: !textEntry });
    if (state.input.mode === "none")
        return null;
    const caretOn = state.tick % 2 === 0;
    return (_jsx(InputPrompt, { mode: state.input.mode, buffer: buffer, settingsField: settingsField, state: state, caretOn: caretOn }));
}
function terminalWidth() { return Math.max((process.stdout.columns ?? 80) || 80, 60); }
function InputPrompt({ mode, buffer, settingsField, state, caretOn }) {
    const termW = terminalWidth();
    const boxW = Math.min(Math.max(44, termW - 6), 120);
    const innerW = boxW - 6;
    const accent = mode === "settings" ? chalk.yellow : mode === "steer" ? chalk.cyan : chalk.magenta;
    const borderColor = mode === "settings" ? "yellow" : mode === "steer" ? "cyan" : "magenta";
    const title = mode === "steer" ? "Steer next wave"
        : mode === "ask" ? "Ask the planner"
            : "Settings";
    let subtitle;
    let hint;
    let currentLine = null;
    const filteredBuffer = buffer;
    if (mode === "settings") {
        const total = SETTINGS_FIELDS.length;
        const field = SETTINGS_FIELDS[settingsField % total];
        subtitle = SETTINGS_LABELS[field];
        const current = readSettingValue(field, state.liveConfig, state.swarm);
        currentLine = chalk.dim(`current: ${chalk.white(current)}`);
        hint = field === "pause"
            ? chalk.dim(`Enter toggle \u00b7 Tab skip \u00b7 Esc exit`)
            : chalk.dim(`[${settingsField + 1}/${total}]  Enter save \u00b7 Tab skip \u00b7 Esc exit`);
    }
    else {
        subtitle = mode === "steer"
            ? "queued as the next wave's seed"
            : "planner answers inline — you keep working";
        const action = mode === "steer" ? "queue" : "send";
        hint = chalk.dim(`Enter ${action} \u00b7 Esc cancel \u00b7 Ctrl+U clear \u00b7 Ctrl+W del word`);
    }
    const bufferLines = filteredBuffer.length === 0
        ? [""]
        : wrap(filteredBuffer, Math.max(20, innerW));
    const caret = caretOn ? accent("\u2588") : " ";
    const lastIdx = bufferLines.length - 1;
    const pct = buffer.length / MAX_INPUT_LEN;
    const counter = buffer.length === 0 ? "" :
        pct >= 0.95 ? chalk.red(`${buffer.length}/${MAX_INPUT_LEN}`)
            : pct >= 0.8 ? chalk.yellow(`${buffer.length}/${MAX_INPUT_LEN}`)
                : chalk.dim(`${buffer.length}/${MAX_INPUT_LEN}`);
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2, borderStyle: "round", borderColor: borderColor, width: boxW, children: [_jsxs(Text, { children: [" ", accent("\u25C6"), " ", chalk.bold.white(title), "  ", chalk.dim(subtitle)] }), currentLine ? _jsxs(Text, { children: [" ", currentLine] }) : null, bufferLines.map((ln, i) => {
                const showCaret = i === lastIdx;
                const pad = Math.max(0, innerW - visibleLen(ln));
                const counterSuffix = showCaret && counter
                    ? "  " + counter
                    : "";
                return (_jsxs(Text, { children: [" ", accent("\u203A "), ln, showCaret ? caret : " ", " ".repeat(pad), counterSuffix] }, i));
            }), _jsxs(Text, { children: [" ", hint] })] }));
}
