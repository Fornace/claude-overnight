// Coverage for the shared raw-stdin parser. Locks in two regressions:
//
//   1. "@ triggered send" — CSI terminator `~` (0x7E) used to leak because the
//      old loop's bound was `< 0x7E`. The followup char ("@") then looked like
//      a typed submit on a later Enter.
//   2. "paste with newline sent early" — Ink fragmented pasted chunks into
//      per-char keypress events, so any `\n` in a paste fired key.return. The
//      parser now treats a multi-byte chunk containing newlines as a paste,
//      not a sequence of typed Enters.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChunk, PASTE_START, PASTE_END, sanitize, deleteWordBackward } from "../ui/raw-input.js";
describe("parseChunk — typed keystrokes", () => {
    it("a single printable char emits one char event", () => {
        assert.deepEqual(parseChunk("a"), [{ type: "char", text: "a" }]);
        assert.deepEqual(parseChunk("@"), [{ type: "char", text: "@" }]);
    });
    it("lone \\r / \\n / \\r\\n = submit", () => {
        assert.deepEqual(parseChunk("\r"), [{ type: "submit" }]);
        assert.deepEqual(parseChunk("\n"), [{ type: "submit" }]);
        assert.deepEqual(parseChunk("\r\n"), [{ type: "submit" }]);
    });
    it("lone ESC = cancel", () => {
        assert.deepEqual(parseChunk("\x1B"), [{ type: "cancel" }]);
    });
    it("backspace / DEL = backspace", () => {
        assert.deepEqual(parseChunk("\x7F"), [{ type: "backspace" }]);
        assert.deepEqual(parseChunk("\b"), [{ type: "backspace" }]);
    });
    it("^U = clear-line, ^W = word-delete, ^C = interrupt", () => {
        assert.deepEqual(parseChunk("\x15"), [{ type: "clear-line" }]);
        assert.deepEqual(parseChunk("\x17"), [{ type: "word-delete" }]);
        assert.deepEqual(parseChunk("\x03"), [{ type: "interrupt" }]);
    });
});
describe("parseChunk — arrow and navigation keys (regression: '@ triggered send')", () => {
    it("ESC[A = up (no char leak)", () => {
        assert.deepEqual(parseChunk("\x1B[A"), [{ type: "nav", name: "up" }]);
    });
    it("ESC[C = right, ESC[D = left", () => {
        assert.deepEqual(parseChunk("\x1B[C"), [{ type: "nav", name: "right" }]);
        assert.deepEqual(parseChunk("\x1B[D"), [{ type: "nav", name: "left" }]);
    });
    it("pgup / pgdn (terminator ~) are fully consumed — no stray '~' char", () => {
        assert.deepEqual(parseChunk("\x1B[5~"), [{ type: "nav", name: "pgup" }]);
        assert.deepEqual(parseChunk("\x1B[6~"), [{ type: "nav", name: "pgdn" }]);
    });
    it("home / end in either form", () => {
        assert.deepEqual(parseChunk("\x1B[H"), [{ type: "nav", name: "home" }]);
        assert.deepEqual(parseChunk("\x1B[F"), [{ type: "nav", name: "end" }]);
        assert.deepEqual(parseChunk("\x1B[1~"), [{ type: "nav", name: "home" }]);
        assert.deepEqual(parseChunk("\x1B[4~"), [{ type: "nav", name: "end" }]);
    });
    it("unknown CSI sequence is silently consumed, not leaked as chars", () => {
        // \x1B[99;99H (cursor position) — no event, no char leak
        assert.deepEqual(parseChunk("\x1B[99;99H"), []);
    });
    it("ESC + '@' does NOT emit a char event for '@' (Meta+@ is dropped)", () => {
        // This is the core of the '@ triggers send' bug: a spurious
        // Option/Meta+@ must not leave '@' in the buffer waiting to become a
        // submit on the next Enter.
        assert.deepEqual(parseChunk("\x1B@"), []);
    });
    it("typing '@' alone still works (sanity check)", () => {
        assert.deepEqual(parseChunk("@"), [{ type: "char", text: "@" }]);
    });
});
describe("parseChunk — paste detection (regression: 'paste with \\n sent early')", () => {
    it("bracketed paste is returned verbatim as a paste event", () => {
        const chunk = `${PASTE_START}hello\nworld${PASTE_END}`;
        assert.deepEqual(parseChunk(chunk), [{ type: "paste", text: "hello\nworld" }]);
    });
    it("bracketed paste does not submit even though it contains \\n", () => {
        const chunk = `${PASTE_START}line1\nline2\nline3${PASTE_END}`;
        const events = parseChunk(chunk);
        assert.equal(events.filter(e => e.type === "submit").length, 0);
        assert.equal(events.length, 1);
        assert.equal(events[0].text, "line1\nline2\nline3");
    });
    it("shape-based paste: multi-byte chunk with embedded \\n = paste, not submit", () => {
        // Terminal without bracketed-paste support: the whole paste arrives as
        // one big data event. The old code submitted on the first \n.
        const chunk = "pasted text\nwith newline\nstill going";
        const events = parseChunk(chunk);
        assert.equal(events.filter(e => e.type === "submit").length, 0);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "paste");
    });
    it("pasted '@' does not submit", () => {
        const chunk = "hello@world\nfoo";
        const events = parseChunk(chunk);
        assert.equal(events.filter(e => e.type === "submit").length, 0);
    });
    it("typing multiple chars quickly (no newline) = chars, not paste", () => {
        // Note: this is still handled as a char event, which is fine since there
        // are no newlines to mistake for a submit.
        assert.deepEqual(parseChunk("abc"), [{ type: "char", text: "abc" }]);
    });
    it("chunk 'a\\rb' (not produced by real terminals) is treated as a paste, not as a submit", () => {
        // Typed keystrokes arrive one byte at a time; if a chunk contains a
        // newline alongside other bytes, it's safer to treat as paste than to
        // submit mid-buffer. The \r is stripped from the paste text.
        const events = parseChunk("a\rb");
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "paste");
        assert.equal(events[0].text, "ab");
    });
    it("text around a bracketed-paste block is kept ordered", () => {
        const chunk = `hi ${PASTE_START}PASTED${PASTE_END} bye`;
        const events = parseChunk(chunk);
        assert.equal(events[0].type, "char");
        assert.equal(events[1].type, "paste");
        assert.equal(events[2].type, "char");
    });
});
describe("sanitize / deleteWordBackward", () => {
    it("sanitize strips C0/DEL/C1 but keeps printable and newlines", () => {
        assert.equal(sanitize("hello\x00\x07"), "hello");
        assert.equal(sanitize("café"), "café");
        assert.equal(sanitize("line1\nline2"), "line1\nline2");
    });
    it("deleteWordBackward removes last word + trailing whitespace", () => {
        assert.equal(deleteWordBackward("foo bar"), "foo ");
        assert.equal(deleteWordBackward("alone"), "");
        assert.equal(deleteWordBackward("foo bar   "), "foo ");
    });
});
