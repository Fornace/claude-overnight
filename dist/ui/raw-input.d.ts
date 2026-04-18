export type InputEvent = {
    type: "char";
    text: string;
} | {
    type: "paste";
    text: string;
} | {
    type: "backspace";
} | {
    type: "word-delete";
} | {
    type: "clear-line";
} | {
    type: "submit";
} | {
    type: "cancel";
} | {
    type: "interrupt";
} | {
    type: "tab";
} | {
    type: "nav";
    name: "up" | "down" | "left" | "right" | "home" | "end" | "pgup" | "pgdn";
};
export declare const PASTE_START = "\u001B[200~";
export declare const PASTE_END = "\u001B[201~";
export declare function sanitize(raw: string): string;
/** Split a chunk into events. Honors bracketed paste, detects paste-by-shape
 *  (multi-byte chunk containing newlines), and cleanly consumes escape
 *  sequences without leaking their terminator as a typed char. */
export declare function parseChunk(chunk: string): InputEvent[];
/** Enable/disable bracketed paste on the given stdout. Best-effort — terminals
 *  that don't support it simply ignore the sequence, and `parseChunk`'s
 *  shape-based paste detection covers them. */
export declare function setBracketedPaste(stdout: NodeJS.WriteStream, enabled: boolean): void;
/** Readline-style word delete: strip trailing whitespace, then strip the last
 *  non-whitespace run. */
export declare function deleteWordBackward(s: string): string;
