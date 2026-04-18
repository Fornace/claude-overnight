// Pure-helper coverage for the text-entry input sanitizer and word-delete.
// Guards the "nav key submits the entry" bug: arrow / cmd+arrow / option+X
// sequences must never leak into the buffer as stray letters.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTyped, deleteWordBackward, MAX_INPUT_LEN } from "../ui/input.js";

describe("sanitizeTyped", () => {
  it("keeps plain printable ASCII verbatim", () => {
    assert.equal(sanitizeTyped("hello"), "hello");
    assert.equal(sanitizeTyped("hello world"), "hello world");
    assert.equal(sanitizeTyped("!@#$%^&*()"), "!@#$%^&*()");
  });

  it("preserves unicode code points", () => {
    assert.equal(sanitizeTyped("café → naïve"), "café → naïve");
    assert.equal(sanitizeTyped("—中文—"), "—中文—");
  });

  it("strips C0 control bytes (arrow ESC flushes, NUL, BEL, etc.)", () => {
    // Lone ESC (\x1b) from a partially-flushed arrow sequence — used to be
    // appended to the buffer as invisible garbage.
    assert.equal(sanitizeTyped("ab\x1bcd"), "abcd");
    assert.equal(sanitizeTyped("\x00text\x07"), "text");
    assert.equal(sanitizeTyped("line\nmore"), "linemore");
    assert.equal(sanitizeTyped("tab\there"), "tabhere");
  });

  it("strips DEL and C1 control range", () => {
    assert.equal(sanitizeTyped("a\x7fb"), "ab");
    assert.equal(sanitizeTyped("a\x80\x9fb"), "ab");
  });

  it("returns empty when input is entirely control bytes", () => {
    assert.equal(sanitizeTyped("\x1b[A"), "[A"); // ESC itself is stripped; printable remainder kept
    assert.equal(sanitizeTyped("\x1b\x1b"), "");
    assert.equal(sanitizeTyped("\x00\x01\x02"), "");
  });

  it("MAX_INPUT_LEN is a sane cap", () => {
    assert.ok(MAX_INPUT_LEN >= 100 && MAX_INPUT_LEN <= 10000);
  });
});

describe("deleteWordBackward", () => {
  it("removes the last word", () => {
    assert.equal(deleteWordBackward("foo bar"), "foo ");
    assert.equal(deleteWordBackward("hello world"), "hello ");
  });

  it("removes a single word completely", () => {
    assert.equal(deleteWordBackward("alone"), "");
  });

  it("removes trailing whitespace with the word", () => {
    assert.equal(deleteWordBackward("foo bar   "), "foo ");
    assert.equal(deleteWordBackward("foo   "), "");
  });

  it("handles multi-space separators", () => {
    assert.equal(deleteWordBackward("alpha    beta"), "alpha    ");
  });

  it("is a no-op on empty string", () => {
    assert.equal(deleteWordBackward(""), "");
    assert.equal(deleteWordBackward("   "), "");
  });
});
