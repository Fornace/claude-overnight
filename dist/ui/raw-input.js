// Shared raw-stdin parser for text entry.
//
// Single source of truth for what a chunk from stdin means. Used by both the
// Ink overlay (src/ui/input.tsx) during a run and the preflight `ask()` prompt
// (src/cli/cli.ts) before a run. Fixes two classes of bugs that existed in
// both copies:
//
//   1. "@ triggered send" — CSI/SS3 terminator check was `< 0x7E` (missed `~`)
//      and the ESC+printable branch silently dropped the next char.
//   2. "paste with newline sent early" — Ink's useInput fragments multi-byte
//      chunks into per-char keypress events, firing key.return on any `\n` in
//      a paste. Here we keep the whole chunk and decide paste-vs-typed-enter
//      by whether the chunk is exactly a newline (typed) or contains
//      newlines alongside other bytes (pasted).
//
// The parser is pure: takes a string chunk, returns an ordered event list.
// Bracketed-paste markers are honored when present but we don't rely on them.
export const PASTE_START = "\x1B[200~";
export const PASTE_END = "\x1B[201~";
// Control chars to strip from any text we append to a buffer. Matches C0
// (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F). Newlines are kept — the caller
// decides per segment whether to strip or preserve them.
const CONTROL_STRIP_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
export function sanitize(raw) {
    return raw.replace(CONTROL_STRIP_RE, "");
}
// CSI/SS3 final byte is in the range 0x40..0x7E inclusive. (The old code used
// `< 0x7E` which dropped past the `~` terminator used by function keys and
// the bracketed-paste close marker.)
function isCsiFinal(code) {
    return code >= 0x40 && code <= 0x7E;
}
// Recognized CSI/SS3 sequences for navigation. Anything else with a valid
// CSI/SS3 shape is silently consumed.
function csiToNav(body) {
    // body = everything between ESC[ (or ESCO) and the terminator, plus terminator
    // Common sequences: A=up, B=down, C=right, D=left, H=home, F=end,
    //                   5~=pgup, 6~=pgdn, 1~/7~=home, 4~/8~=end
    if (body === "A")
        return { type: "nav", name: "up" };
    if (body === "B")
        return { type: "nav", name: "down" };
    if (body === "C")
        return { type: "nav", name: "right" };
    if (body === "D")
        return { type: "nav", name: "left" };
    if (body === "H" || body === "1~" || body === "7~")
        return { type: "nav", name: "home" };
    if (body === "F" || body === "4~" || body === "8~")
        return { type: "nav", name: "end" };
    if (body === "5~")
        return { type: "nav", name: "pgup" };
    if (body === "6~")
        return { type: "nav", name: "pgdn" };
    return null;
}
/** Split a chunk into events. Honors bracketed paste, detects paste-by-shape
 *  (multi-byte chunk containing newlines), and cleanly consumes escape
 *  sequences without leaking their terminator as a typed char. */
export function parseChunk(chunk) {
    const out = [];
    if (!chunk)
        return out;
    // First pass: carve out bracketed-paste blocks. Everything outside those
    // markers is "free text" — we still apply shape-based paste detection to it.
    const parts = [];
    let i = 0;
    while (i < chunk.length) {
        const ps = chunk.indexOf(PASTE_START, i);
        if (ps === -1) {
            parts.push({ kind: "free", text: chunk.slice(i) });
            break;
        }
        if (ps > i)
            parts.push({ kind: "free", text: chunk.slice(i, ps) });
        const bodyStart = ps + PASTE_START.length;
        const pe = chunk.indexOf(PASTE_END, bodyStart);
        if (pe === -1) {
            parts.push({ kind: "paste", text: chunk.slice(bodyStart) });
            break;
        }
        parts.push({ kind: "paste", text: chunk.slice(bodyStart, pe) });
        i = pe + PASTE_END.length;
    }
    for (const part of parts) {
        if (part.kind === "paste") {
            if (part.text)
                out.push({ type: "paste", text: part.text });
            continue;
        }
        // Free text: walk byte by byte, consuming escape sequences and control
        // bytes. Typed enter = a chunk that's EXACTLY "\r", "\n", or "\r\n".
        const s = part.text;
        if (!s)
            continue;
        // Fast path: a chunk that is just enter, tab, backspace, or ^C.
        if (s === "\r" || s === "\n" || s === "\r\n") {
            out.push({ type: "submit" });
            continue;
        }
        if (s === "\x03") {
            out.push({ type: "interrupt" });
            continue;
        }
        if (s === "\x7F" || s === "\b") {
            out.push({ type: "backspace" });
            continue;
        }
        if (s === "\t") {
            out.push({ type: "tab" });
            continue;
        }
        if (s === "\x1B") {
            out.push({ type: "cancel" });
            continue;
        }
        if (s === "\x15") {
            out.push({ type: "clear-line" });
            continue;
        } // ^U
        if (s === "\x17") {
            out.push({ type: "word-delete" });
            continue;
        } // ^W
        // Shape-based paste: multi-char chunk containing a newline that is NOT
        // just "\r\n". Terminals buffer keypresses at ~1 byte; paste comes in as
        // a single large chunk. Anything multi-char with embedded newlines is
        // paste, not a sequence of typed Enters.
        if ((s.includes("\n") || s.includes("\r")) && s.length > 2) {
            const stripped = s.replace(/\r/g, "");
            if (stripped)
                out.push({ type: "paste", text: stripped });
            continue;
        }
        // Otherwise walk the chunk one logical token at a time.
        let j = 0;
        let buf = "";
        const flushBuf = () => { if (buf) {
            out.push({ type: "char", text: buf });
            buf = "";
        } };
        while (j < s.length) {
            const ch = s[j];
            if (ch === "\r" || ch === "\n") {
                // Bare newline embedded inside a short non-paste chunk: treat as
                // submit if it's the tail, otherwise drop (shouldn't happen in well-
                // formed terminal input — paste goes through the shape path above).
                flushBuf();
                out.push({ type: "submit" });
                j++;
                continue;
            }
            if (ch === "\x03") {
                flushBuf();
                out.push({ type: "interrupt" });
                j++;
                continue;
            }
            if (ch === "\x7F" || ch === "\b") {
                flushBuf();
                out.push({ type: "backspace" });
                j++;
                continue;
            }
            if (ch === "\t") {
                flushBuf();
                out.push({ type: "tab" });
                j++;
                continue;
            }
            if (ch === "\x15") {
                flushBuf();
                out.push({ type: "clear-line" });
                j++;
                continue;
            }
            if (ch === "\x17") {
                flushBuf();
                out.push({ type: "word-delete" });
                j++;
                continue;
            }
            if (ch === "\x1B") {
                flushBuf();
                const next = j + 1 < s.length ? s[j + 1] : null;
                if (next === null) {
                    out.push({ type: "cancel" });
                    j++;
                    continue;
                }
                if (next === "[" || next === "O") {
                    // CSI or SS3: consume up to and including the final byte (0x40..0x7E).
                    let k = j + 2;
                    let body = "";
                    while (k < s.length) {
                        const code = s.charCodeAt(k);
                        body += s[k];
                        k++;
                        if (isCsiFinal(code))
                            break;
                    }
                    const nav = csiToNav(body);
                    if (nav)
                        out.push(nav);
                    j = k;
                    continue;
                }
                // ESC + printable = Meta/Alt + key. Drop both bytes; upstream can
                // surface specific combos later if needed.
                j += 2;
                continue;
            }
            const code = ch.charCodeAt(0);
            // Skip remaining control bytes silently.
            if (code < 0x20 || (code >= 0x7F && code < 0xA0)) {
                j++;
                continue;
            }
            buf += ch;
            j++;
        }
        flushBuf();
    }
    return out;
}
/** Enable/disable bracketed paste on the given stdout. Best-effort — terminals
 *  that don't support it simply ignore the sequence, and `parseChunk`'s
 *  shape-based paste detection covers them. */
export function setBracketedPaste(stdout, enabled) {
    try {
        stdout.write(enabled ? "\x1B[?2004h" : "\x1B[?2004l");
    }
    catch { }
}
/** Readline-style word delete: strip trailing whitespace, then strip the last
 *  non-whitespace run. */
export function deleteWordBackward(s) {
    const trimmed = s.replace(/\s+$/, "");
    const idx = trimmed.search(/\S+$/);
    return idx < 0 ? "" : trimmed.slice(0, idx);
}
