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
//
// Text-entry input hygiene: terminals send a zoo of escape/control sequences
// for navigation keys (arrows, cmd+arrow → ctrl+a/e on macOS, option+letter,
// pageup/pgdn, home/end, lone ESC flushes). We explicitly swallow all of them
// instead of letting them fall through to the "typed char" branch, which used
// to corrupt the buffer or dismiss the overlay and discard unfinished text.

import React, { useState, useSyncExternalStore } from "react";
import { Text, Box, useInput } from "ink";
import chalk from "chalk";
import type { UiStore, HostCallbacks } from "./store.js";
import { visibleLen, wrap } from "./primitives.js";
import {
  SETTINGS_FIELDS,
  SETTINGS_LABELS,
  NUMERIC_SETTINGS_FIELDS,
  applySettingEdit,
  readSettingValue,
} from "./settings.js";

export const MAX_INPUT_LEN = 600;

// Any printable char is kept verbatim; everything else is filtered out before
// touching the buffer. Matches: ASCII C0 controls (0x00-0x1F), DEL (0x7F), C1
// controls (0x80-0x9F), and lone ESC (already handled by `key.escape`).
export const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** Strip control characters from typed raw input so escape flushes, newlines,
 *  and C1 bytes never end up in the user's buffer. Exported for tests. */
export function sanitizeTyped(raw: string): string {
  return raw.replace(CONTROL_CHAR_RE, "");
}

/** Delete the previous word including any trailing whitespace, readline-style.
 *  Bound to Ctrl+W and Opt/Cmd+Backspace. Exported for tests. */
export function deleteWordBackward(s: string): string {
  const trimmed = s.replace(/\s+$/, "");
  const idx = trimmed.search(/\S+$/);
  return idx < 0 ? "" : trimmed.slice(0, idx);
}

interface Props {
  store: UiStore;
  callbacks: HostCallbacks;
  onToast(msg: string): void;
}

export function InputLayer({ store, callbacks, onToast }: Props): React.ReactElement | null {
  const [buffer, setBuffer] = useState("");
  const [settingsField, setSettingsField] = useState(0);

  useInput((raw, key) => {
    const state = store.get();
    const mode = state.input.mode;
    const swarm = state.swarm;
    const lc = state.liveConfig;

    // ── Text-entry modes ──
    if (mode !== "none") {
      // Navigation keys must NEVER touch the buffer or dismiss the overlay.
      // (Bug: cmd+arrow on macOS Terminal sends ctrl+a/ctrl+e which used to
      // leak through and append "a"/"e"; arrows on some terminals flushed
      // partial ESC sequences that dropped the user's unfinished text.)
      if (
        key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown || key.home || key.end
      ) return;

      // Esc bails (loses the buffer — always intentional).
      if (key.escape) {
        setBuffer("");
        setSettingsField(0);
        store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
        return;
      }
      if (key.return) {
        const text = buffer.trim();
        if (mode === "steer" && text) callbacks.onSteer(text);
        else if (mode === "ask" && text) callbacks.onAsk(text);
        else if (mode === "settings") {
          const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
          if (lc) applySettingEdit(field, text, lc, swarm);
          callbacks.settingsTick();
          const next = settingsField + 1;
          setBuffer("");
          if (next >= SETTINGS_FIELDS.length) {
            setSettingsField(0);
            store.patch({ input: { mode: "none", buffer: "", settingsField: 0 } });
          } else {
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

      // Word-delete: option/alt + backspace — expected on macOS.
      if ((key.meta || key.ctrl) && (key.backspace || key.delete)) {
        const next = deleteWordBackward(buffer);
        setBuffer(next);
        store.patch({ input: { ...state.input, buffer: next } });
        return;
      }

      // Swallow modifier combos so they can't leak as stray letters.
      // (cmd+→ on macOS Terminal = \x05 = ctrl+e → input handler sees raw='e';
      // without this guard we used to append 'e'.)
      if (key.ctrl || key.meta) {
        if (mode !== "settings" && key.ctrl && raw === "u") {
          // ctrl+U: clear the whole line — standard readline behavior.
          setBuffer("");
          store.patch({ input: { ...state.input, buffer: "" } });
          return;
        }
        if (key.ctrl && raw === "w") {
          const next = deleteWordBackward(buffer);
          setBuffer(next);
          store.patch({ input: { ...state.input, buffer: next } });
          return;
        }
        return;
      }

      if (key.tab) {
        if (mode === "settings") {
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
          } else {
            setSettingsField(next);
            store.patch({ input: { mode: "settings", buffer: "", settingsField: next } });
          }
        }
        // Tab in steer/ask modes is a no-op, not a submit or a "tab character".
        return;
      }

      if (key.backspace || key.delete) {
        const next = buffer.slice(0, -1);
        setBuffer(next);
        store.patch({ input: { ...state.input, buffer: next } });
        return;
      }

      // Typed printable char(s) — raw is the string for this event. Strip any
      // control chars (lone ESC flushes, \n linefeeds parseKeypress labels as
      // 'enter', partial ESC [ sequences) before touching the buffer.
      if (raw && raw.length > 0) {
        let text = sanitizeTyped(raw);
        if (mode === "settings") {
          const field = SETTINGS_FIELDS[settingsField % SETTINGS_FIELDS.length];
          if (NUMERIC_SETTINGS_FIELDS.has(field)) text = text.replace(/[^0-9.]/g, "");
          if (field === "pause") return;
        }
        if (!text) return;
        const next = (buffer + text).slice(0, MAX_INPUT_LEN);
        setBuffer(next);
        store.patch({ input: { ...state.input, buffer: next } });
      }
      return;
    }

    // ── Hotkey mode ──

    // Arrow keys — agent detail cycle
    if (key.rightArrow || key.downArrow) { callbacks.cycleAgent(1); return; }
    if (key.upArrow) { callbacks.cycleAgent(-1); return; }
    if (key.leftArrow) { callbacks.clearSelectedAgent(); return; }

    // Escape in hotkey mode — clear agent selection or dismiss answered ask
    if (key.escape) {
      if (state.selectedAgentId != null) { callbacks.clearSelectedAgent(); return; }
      if (state.ask && !state.ask.streaming) { callbacks.clearAsk(); return; }
      return;
    }

    // Ctrl-C: abort swarm or exit
    if (key.ctrl && raw === "c") {
      if (swarm && !swarm.aborted) { swarm.abort(); return; }
      process.exit(0);
    }

    // Enter in hotkey mode — reveal ask answer file in Finder if we have one
    if (key.return) {
      if (state.askTempFileAvailable) callbacks.openAskTempFile();
      return;
    }

    if (!raw || raw.length !== 1) return;
    const code = raw.charCodeAt(0);
    if (code < 0x20 || code > 0x7E) return;
    // Any ctrl/meta combo (that isn't one of the specific hotkeys above) is
    // nav-adjacent on most terminals; ignore instead of matching "c"/"i" etc.
    if (key.ctrl || key.meta) return;

    const toast = (msg: string) => onToast(msg);

    switch (raw.toLowerCase()) {
      case "?":
        if (!state.hasOnAsk) return toast("Ask not wired for this run");
        if (state.askBusy || state.ask?.streaming) return toast("Ask already in flight");
        if (state.ask && !state.ask.streaming) { callbacks.clearAsk(); return; }
        store.patch({ input: { mode: "ask", buffer: "", settingsField: 0 } });
        setBuffer("");
        return;
      case "i":
        if (!state.hasOnSteer) return toast("Steering not wired for this run");
        store.patch({ input: { mode: "steer", buffer: "", settingsField: 0 } });
        setBuffer("");
        return;
      case "d":
        // Show latest debrief entry in the overlay; if nothing yet, toast.
        if (state.debrief) return; // already visible
        if (state.debriefHistory.length > 0) {
          const last = state.debriefHistory[state.debriefHistory.length - 1];
          store.patch({ debrief: { text: last.text, label: last.label } });
          return;
        }
        toast("No debrief yet");
        return;
      case "p":
        if (!swarm || !lc) return toast("No live wave to pause");
        swarm.setPaused(!swarm.paused);
        lc.paused = swarm.paused;
        lc.dirty = true;
        callbacks.settingsTick();
        return;
      case "s":
        if (!lc) return toast("Settings unavailable");
        setSettingsField(0);
        setBuffer("");
        store.patch({ input: { mode: "settings", buffer: "", settingsField: 0 } });
        return;
      case "f":
        if (!swarm || swarm.failed <= 0 || swarm.active <= 0) return toast("No failed branches to fall back from");
        swarm.requeueFailed();
        return;
      case "r":
        if (!swarm || swarm.rateLimitPaused <= 0) return toast("Not paused for rate-limit");
        swarm.retryRateLimitNow();
        return;
      case "q":
        // Second press with the current swarm already aborted = hard exit.
        if (swarm?.aborted) process.exit(0);
        // Always request quit: flips the runner's `stopping` flag so the wave
        // loop breaks instead of advancing to steering / post-run review.
        callbacks.requestQuit();
        return;
    }

    if (/^[0-9]$/.test(raw) && swarm) {
      const n = parseInt(raw, 10);
      const running = swarm.agents.filter(a => a.status === "running");
      if (n < running.length) callbacks.selectAgent(running[n].id);
    }
  });

  // Render the active text-entry prompt under the footer hint.
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (state.input.mode === "none") return null;
  const caretOn = state.tick % 2 === 0;
  return (
    <InputPrompt
      mode={state.input.mode}
      buffer={buffer}
      settingsField={settingsField}
      state={state}
      caretOn={caretOn}
    />
  );
}

function terminalWidth(): number { return Math.max((process.stdout.columns ?? 80) || 80, 60); }

interface PromptProps {
  mode: "steer" | "ask" | "settings";
  buffer: string;
  settingsField: number;
  state: ReturnType<UiStore["get"]>;
  caretOn: boolean;
}

function InputPrompt({ mode, buffer, settingsField, state, caretOn }: PromptProps): React.ReactElement {
  const termW = terminalWidth();
  const boxW = Math.min(Math.max(44, termW - 6), 120);
  const innerW = boxW - 6;

  const accent = mode === "settings" ? chalk.yellow : mode === "steer" ? chalk.cyan : chalk.magenta;
  const borderColor = mode === "settings" ? "yellow" : mode === "steer" ? "cyan" : "magenta";

  const title = mode === "steer" ? "Steer next wave"
    : mode === "ask" ? "Ask the planner"
    : "Settings";

  let subtitle: string;
  let hint: string;
  let currentLine: string | null = null;
  let filteredBuffer = buffer;

  if (mode === "settings") {
    const total = SETTINGS_FIELDS.length;
    const field = SETTINGS_FIELDS[settingsField % total];
    subtitle = SETTINGS_LABELS[field];
    const current = readSettingValue(field, state.liveConfig, state.swarm);
    currentLine = chalk.dim(`current: ${chalk.white(current)}`);
    hint = field === "pause"
      ? chalk.dim(`Enter toggle \u00b7 Tab skip \u00b7 Esc exit`)
      : chalk.dim(`[${settingsField + 1}/${total}]  Enter save \u00b7 Tab skip \u00b7 Esc exit`);
  } else {
    subtitle = mode === "steer"
      ? "queued as the next wave's seed"
      : "planner answers inline — you keep working";
    const action = mode === "steer" ? "queue" : "send";
    hint = chalk.dim(`Enter ${action} \u00b7 Esc cancel \u00b7 Ctrl+U clear \u00b7 Ctrl+W del word`);
  }

  // Word-wrap the buffer so long entries don't blow past the box edge.
  const bufferLines = filteredBuffer.length === 0
    ? [""]
    : wrap(filteredBuffer, Math.max(20, innerW));
  const caret = caretOn ? accent("\u2588") : " ";
  const lastIdx = bufferLines.length - 1;

  // Char counter — dims normally, warns at 80%, red at 95%.
  const pct = buffer.length / MAX_INPUT_LEN;
  const counter = buffer.length === 0 ? "" :
    pct >= 0.95 ? chalk.red(`${buffer.length}/${MAX_INPUT_LEN}`)
    : pct >= 0.8 ? chalk.yellow(`${buffer.length}/${MAX_INPUT_LEN}`)
    : chalk.dim(`${buffer.length}/${MAX_INPUT_LEN}`);

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2} borderStyle="round" borderColor={borderColor} width={boxW}>
      <Text> {accent("\u25C6")} {chalk.bold.white(title)}  {chalk.dim(subtitle)}</Text>
      {currentLine ? <Text> {currentLine}</Text> : null}
      {bufferLines.map((ln, i) => {
        const showCaret = i === lastIdx;
        const pad = Math.max(0, innerW - visibleLen(ln));
        const counterSuffix = showCaret && counter
          ? "  " + counter
          : "";
        return (
          <Text key={i}>
            {" "}{accent("\u203A ")}{ln}{showCaret ? caret : " "}{" ".repeat(pad)}{counterSuffix}
          </Text>
        );
      })}
      <Text> {hint}</Text>
    </Box>
  );
}
