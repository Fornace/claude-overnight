// Keyboard input pipeline for the live display.
//
// Raw stdin chunks come in via `RunDisplay`'s data listener and flow through
// here, which owns three things:
//
//   1. The mutable input state — current mode (none/settings/steer/ask),
//      typed segments, and which settings field is being edited.
//   2. The keyboard demux — splits paste from typed bytes, routes ESC
//      sequences and modifiers, then matches hotkeys.
//   3. The input prompt rendering — the bottom strip the user types into.
//
// Side effects on the display happen via the small `KeyboardHost` interface
// so this module never reaches into RunDisplay's private state.

import chalk from "chalk";
import { execSync } from "child_process";
import type { Swarm } from "../swarm/swarm.js";
import type { InteractivePanel } from "./interactive-panel.js";
import {
  type InputSegment,
  splitPaste,
  segmentsToString,
  renderSegments,
  appendCharToSegments,
  appendPasteToSegments,
  backspaceSegments,
} from "../cli/cli.js";
import type { AskState, LiveConfig } from "./types.js";
import {
  SETTINGS_FIELDS,
  SETTINGS_LABELS,
  NUMERIC_SETTINGS_FIELDS,
  applySettingEdit,
  readSettingValue,
} from "./settings.js";

export const MAX_INPUT_LEN = 600;

export type InputMode = "none" | "settings" | "steer" | "ask";

/** All keyboard-input state owned by the input module. RunDisplay holds one of
 *  these per session and passes it back in for every chunk. */
export class InputState {
  mode: InputMode = "none";
  segs: InputSegment[] = [];
  settingsField = 0;

  reset(): void {
    this.mode = "none";
    this.segs = [];
  }
}

/** The narrow surface RunDisplay must expose for the keyboard module to do
 *  its job. Everything here is read-only data or a side-effect method — the
 *  input state itself lives in `InputState`, never on the host. */
export interface KeyboardHost {
  readonly panel: InteractivePanel;
  readonly swarm: Swarm | undefined;
  readonly liveConfig: LiveConfig | undefined;
  readonly selectedAgentId: number | undefined;
  readonly askState: AskState | undefined;
  readonly askBusy: boolean;
  readonly hasOnSteer: boolean;
  readonly hasOnAsk: boolean;
  readonly hasAskTempFile: boolean;

  navigate(direction: "up" | "down" | "left" | "right" | "enter"): boolean;
  clearSelectedAgent(): void;
  cycleSelectedAgent(): void;
  selectAgent(id: number): void;
  clearAskState(): void;
  emitSteer(text: string): void;
  emitAsk(text: string): void;
  openAskTempFile(): void;
}

// ── Paste handling ──

/** Apply a pasted block. Returns true if the frame needs a redraw. Numeric
 *  settings fields strip non-digit bytes so accidentally pasting a label
 *  ("70%") keeps just the number. */
export function handlePaste(host: KeyboardHost, state: InputState, text: string): boolean {
  if (state.mode === "settings") {
    const field = SETTINGS_FIELDS[state.settingsField % SETTINGS_FIELDS.length];
    if (NUMERIC_SETTINGS_FIELDS.has(field)) {
      const clean = text.replace(/[^0-9.]/g, "");
      if (clean) appendCharToSegments(state.segs, clean);
      return !!clean;
    }
    if (field !== "pause" && text.length + segmentsToString(state.segs).length <= MAX_INPUT_LEN) {
      appendPasteToSegments(state.segs, text);
      return true;
    }
  }
  if (state.mode === "steer" || state.mode === "ask") {
    if (segmentsToString(state.segs).length + text.length > MAX_INPUT_LEN) return false;
    appendPasteToSegments(state.segs, text);
    return true;
  }
  return false;
}

// ── Fullscreen-panel keyboard ──

/** Keyboard handler used only while the panel is expanded fullscreen.
 *  Handles scroll + close. Swallows everything else so the normal hotkeys
 *  (s/p/i/?/d/0-9) do not fire while the user is reading. */
export function handlePanelKey(host: KeyboardHost, s: string): boolean {
  const panel = host.panel;
  const bodyRows = Math.max(3, (process.stdout.rows || 40) - 7);
  // CSI sequences: arrows, PgUp/PgDn, Home/End
  if (s.startsWith("\x1B[")) {
    if (s === "\x1B[A") { panel.scroll("up", bodyRows); return true; }
    if (s === "\x1B[B") { panel.scroll("down", bodyRows); return true; }
    if (s === "\x1B[5~") { panel.pageScroll("up", bodyRows); return true; }
    if (s === "\x1B[6~") { panel.pageScroll("down", bodyRows); return true; }
    if (s === "\x1B[H" || s === "\x1B[1~") { panel.scrollToTop(); return true; }
    if (s === "\x1B[F" || s === "\x1B[4~") { panel.scrollToBottom(bodyRows); return true; }
    return false; // swallow other CSIs silently
  }
  // Bare ESC: collapse if expanded, close if collapsed
  if (s === "\x1B") {
    if (panel.state.expanded) panel.collapse();
    else panel.close();
    return true;
  }
  // Ctrl-O: toggle (collapse)
  if (s === "\x0F") { panel.toggle(); return true; }
  // Ctrl-C: keep the usual abort / exit behavior even while expanded
  if (s === "\x03") {
    if (host.swarm && !host.swarm.aborted) { host.swarm.abort(); return true; }
    process.exit(0);
  }
  // Vim-style jumps
  if (s === "g") { panel.scrollToTop(); return true; }
  if (s === "G") { panel.scrollToBottom(bodyRows); return true; }
  // Space / j / k as extra scroll conveniences
  if (s === " " || s === "j") { panel.scroll("down", bodyRows); return true; }
  if (s === "k") { panel.scroll("up", bodyRows); return true; }
  // Swallow everything else
  return false;
}

// ── Main typed-key dispatcher ──

/** Handle a typed (non-pasted) chunk. Returns true if the frame needs a redraw.
 *
 *  Demux pipeline — routes escape sequences and modifiers BEFORE hotkey matching:
 *    Raw stdin chunk → splitPaste
 *      ├─ paste → handlePaste
 *      └─ typed → handleTyped (this function)
 *           0. panel expanded  → handlePanelKey (steals all input)
 *           1. ESC + [A/B/C/D  → navigate; other CSI → swallow
 *           2. ESC + non-[     → Alt/Option+key → swallow
 *           3. ESC alone       → cancel input / close detail / dismiss panel
 *           4. settings input  → digits/text, Enter, Backspace, Tab to skip
 *           5. text input      → printable chars, Enter, Backspace, ESC (with lookahead)
 *           6. hotkey mode     → s (settings), i (inject), q, ?, d, 0-9, f, r, p
 */
export function handleTyped(host: KeyboardHost, state: InputState, s: string): boolean {
  // ── 0. Fullscreen panel owns the keyboard ──
  if (host.panel.state.expanded) {
    return handlePanelKey(host, s);
  }

  // ── 1. Arrow keys: \x1B[A = up, \x1B[B = down, \x1B[C = right, \x1B[D = left ──
  if (s.startsWith("\x1B[")) {
    const dir = s[2];
    if (dir === "A") { host.navigate("up"); return true; }
    if (dir === "B") { host.navigate("down"); return true; }
    if (dir === "C") { host.navigate("right"); return true; }
    if (dir === "D") { host.navigate("left"); return true; }
    return true; // swallow other CSI sequences
  }

  // ── 2. Alt/Option+key: \x1B followed by a non-bracket byte (e.g. \x1Bb, \x1Bf) ──
  if (s.length >= 2 && s[0] === "\x1B" && s[1] !== "[") {
    return false; // swallow — don't cancel input, don't trigger hotkeys
  }

  // ── 3. Standalone ESC ──
  if (s === "\x1B") {
    if (state.mode !== "none") {
      state.reset();
      return true;
    }
    if (host.selectedAgentId != null) {
      host.clearSelectedAgent();
      return true;
    }
    if (host.askState && !host.askState.streaming) {
      host.clearAskState();
      return true;
    }
    return false;
  }

  // Tab in settings mode — advances the field cursor; for the `pause` field
  // it also performs the toggle so users can confirm without typing anything.
  if (s === "\t" && state.mode === "settings") {
    const lc = host.liveConfig;
    const field = SETTINGS_FIELDS[state.settingsField % SETTINGS_FIELDS.length];
    if (field === "pause" && host.swarm && lc) {
      const next = !host.swarm.paused;
      host.swarm.setPaused(next);
      lc.paused = next;
      lc.dirty = true;
    }
    state.settingsField++;
    state.segs = [];
    if (state.settingsField >= SETTINGS_FIELDS.length) state.mode = "none";
    return true;
  }

  // ── 4. Settings mode ──
  if (state.mode === "settings") {
    const lc = host.liveConfig;
    if (!lc) return false;
    let dirty = false;
    for (const ch of s) {
      if (ch === "\r" || ch === "\n") {
        const field = SETTINGS_FIELDS[state.settingsField % SETTINGS_FIELDS.length];
        const raw = segmentsToString(state.segs).trim();
        applySettingEdit(field, raw, lc, host.swarm);
        state.settingsField++;
        if (state.settingsField >= SETTINGS_FIELDS.length) state.mode = "none";
        state.segs = [];
        return true;
      }
      if (ch === "\x03") { state.reset(); return true; }
      if (ch === "\x7F") { backspaceSegments(state.segs); dirty = true; continue; }
      const field = SETTINGS_FIELDS[state.settingsField % SETTINGS_FIELDS.length];
      if (NUMERIC_SETTINGS_FIELDS.has(field)) {
        if (/^[0-9.]$/.test(ch)) { appendCharToSegments(state.segs, ch); dirty = true; }
      } else if (field !== "pause") {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7E) { appendCharToSegments(state.segs, ch); dirty = true; }
      }
    }
    return dirty;
  }

  // ── 5. Free-text input mode (steer / ask) ──
  if (state.mode === "steer" || state.mode === "ask") {
    let dirty = false;
    // Iterate by code point so emoji/surrogate pairs stay intact.
    const chars = Array.from(s);
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      if (ch === "\r" || ch === "\n") {
        const text = segmentsToString(state.segs).trim();
        const wasAsk = state.mode === "ask";
        state.reset();
        if (text) {
          if (wasAsk) host.emitAsk(text);
          else host.emitSteer(text);
        }
        return true;
      }
      if (ch === "\x03") { state.reset(); return true; }
      // ESC: if another byte follows it's part of an Alt+key sequence — skip both.
      // Standalone ESC (no following byte) cancels input mode.
      if (ch === "\x1B") {
        if (ci + 1 < chars.length) { ci++; continue; }
        state.reset();
        return true;
      }
      if (ch === "\x7F" || ch === "\b") {
        backspaceSegments(state.segs);
        dirty = true;
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      // Reject C0/C1 control characters; accept everything else including Unicode.
      if (code < 0x20) continue;
      if (code >= 0x7F && code < 0xA0) continue;
      if (segmentsToString(state.segs).length + ch.length <= MAX_INPUT_LEN) {
        appendCharToSegments(state.segs, ch);
        dirty = true;
      }
    }
    return dirty;
  }

  // ── 6. Hotkey mode ──

  // Enter — when an answered ask has its full body in a temp file, reveal it
  // in Finder. Otherwise no-op.
  if (s === "\r" || s === "\n") {
    if (host.hasAskTempFile) host.openAskTempFile();
    return true;
  }

  // Ctrl+C
  if (s === "\x03") {
    if (host.swarm && !host.swarm.aborted) host.swarm.abort();
    else process.exit(0);
    return true;
  }

  // Ctrl+O: toggle interactive panel expand/collapse
  if (s === "\x0F") {
    if (host.panel.visible) { host.panel.toggle(); return true; }
    return false;
  }

  // Only single printable ASCII characters reach hotkey matching
  if (s.length !== 1) return false;
  const key = s[0];
  const code = key.charCodeAt(0);
  if (code < 0x20 || code > 0x7E) return false;

  const lc = host.liveConfig;
  const swarm = host.swarm;

  if (key === "s" || key === "S") {
    if (!swarm) return false;
    state.mode = "settings";
    state.settingsField = 0;
    state.segs = [];
    return true;
  }
  if (key === "p" || key === "P") {
    if (swarm && lc) {
      const next = !swarm.paused;
      swarm.setPaused(next);
      lc.paused = next;
      lc.dirty = true;
      return true;
    }
    return false;
  }
  if ((key === "f" || key === "F") && swarm && swarm.failed > 0 && swarm.active > 0) {
    swarm.requeueFailed();
    return false;
  }
  if ((key === "r" || key === "R") && swarm && swarm.rateLimitPaused > 0) {
    swarm.retryRateLimitNow();
    return true;
  }
  if ((key === "i" || key === "I") && host.hasOnSteer) {
    state.mode = "steer"; state.segs = []; return true;
  }
  if (key === "?" && host.hasOnAsk && swarm && !host.askBusy) {
    if (host.askState && !host.askState.streaming) { host.clearAskState(); return true; }
    state.mode = "ask"; state.segs = []; return true;
  }
  // [d] cycle agent detail panel
  if ((key === "d" || key === "D") && swarm && swarm.active > 0) {
    host.cycleSelectedAgent();
    return true;
  }
  // Number keys 0-9 select a specific agent by row index in the visible table
  if (/^[0-9]$/.test(key) && swarm) {
    const n = parseInt(key);
    const running = swarm.agents.filter(a => a.status === "running");
    if (n < running.length) { host.selectAgent(running[n].id); return true; }
  }
  if (key === "q" || key === "Q") {
    if (swarm) {
      if (swarm.aborted) process.exit(0);
      swarm.abort();
    } else {
      process.exit(0);
    }
  }
  return false;
}

// ── Input prompt rendering ──

/** Render the bottom input strip. Returns "" when no prompt is active. */
export function renderInputPrompt(host: KeyboardHost, state: InputState): string {
  if (state.mode === "none") return "";
  const rendered = renderSegments(state.segs);
  if (state.mode === "settings") {
    const total = SETTINGS_FIELDS.length;
    const field = SETTINGS_FIELDS[state.settingsField % total];
    const label = SETTINGS_LABELS[field];
    const idx = state.settingsField + 1;
    const currentValue = readSettingValue(field, host.liveConfig, host.swarm);
    const hint = field === "pause"
      ? chalk.dim(` (Enter to toggle, Tab to skip, Esc to exit)`)
      : chalk.dim(` [${idx}/${total}]  Tab=next  Esc=exit  current: ${chalk.white(currentValue)}`);
    return `\n  ${chalk.cyan("\u25C6")} ${chalk.bold(label)}${hint}\n  ${rendered}\u2588`;
  }
  if (state.mode === "steer") {
    return `\n  ${chalk.cyan(">")} ${chalk.bold("Inject next wave")} ${chalk.dim("(Enter to queue, Esc to cancel)")}\n  ${rendered}\u2588`;
  }
  if (state.mode === "ask") {
    return `\n  ${chalk.cyan(">")} ${chalk.bold("Ask the planner")} ${chalk.dim("(Enter to send, Esc to cancel)")}\n  ${rendered}\u2588`;
  }
  return "";
}

// ── stdin wiring ──

/** Wire raw stdin to the keyboard pipeline. Returns the listener so the caller
 *  can later detach it. Caller is responsible for setRawMode + bracketed-paste
 *  enable/disable around the lifetime of this listener. */
export function bindKeyboard(
  host: KeyboardHost,
  state: InputState,
  onDirty: () => void,
): (buf: Buffer) => void {
  const listener = (buf: Buffer): void => {
    const chunk = buf.toString();
    let dirty = false;
    for (const seg of splitPaste(chunk)) {
      if (seg.type === "paste") {
        if (handlePaste(host, state, seg.text)) dirty = true;
      } else {
        if (handleTyped(host, state, seg.text)) dirty = true;
      }
    }
    if (dirty) onDirty();
  };
  process.stdin.on("data", listener);
  return listener;
}

// Exposed for tests / re-export from ui.ts.
export { splitPaste, segmentsToString };
