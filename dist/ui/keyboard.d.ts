import type { Swarm } from "../swarm/swarm.js";
import type { InteractivePanel } from "./interactive-panel.js";
import { type InputSegment, splitPaste, segmentsToString } from "../cli/cli.js";
import type { AskState, LiveConfig } from "./types.js";
export declare const MAX_INPUT_LEN = 600;
export type InputMode = "none" | "settings" | "steer" | "ask";
/** All keyboard-input state owned by the input module. RunDisplay holds one of
 *  these per session and passes it back in for every chunk. */
export declare class InputState {
    mode: InputMode;
    segs: InputSegment[];
    settingsField: number;
    reset(): void;
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
/** Apply a pasted block. Returns true if the frame needs a redraw. Numeric
 *  settings fields strip non-digit bytes so accidentally pasting a label
 *  ("70%") keeps just the number. */
export declare function handlePaste(host: KeyboardHost, state: InputState, text: string): boolean;
/** Keyboard handler used only while the panel is expanded fullscreen.
 *  Handles scroll + close. Swallows everything else so the normal hotkeys
 *  (s/p/i/?/d/0-9) do not fire while the user is reading. */
export declare function handlePanelKey(host: KeyboardHost, s: string): boolean;
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
export declare function handleTyped(host: KeyboardHost, state: InputState, s: string): boolean;
/** Render the bottom input strip. Returns "" when no prompt is active. */
export declare function renderInputPrompt(host: KeyboardHost, state: InputState): string;
/** Wire raw stdin to the keyboard pipeline. Returns the listener so the caller
 *  can later detach it. Caller is responsible for setRawMode + bracketed-paste
 *  enable/disable around the lifetime of this listener. */
export declare function bindKeyboard(host: KeyboardHost, state: InputState, onDirty: () => void): (buf: Buffer) => void;
export { splitPaste, segmentsToString };
