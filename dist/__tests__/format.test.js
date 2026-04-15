import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Copied from src/ui.ts  -- these are not exported
function fmtTokens(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
function fmtDur(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function truncate(s, max) {
    return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}
// Tests
describe("fmtTokens", () => {
    it("returns raw number below 1K", () => {
        assert.equal(fmtTokens(0), "0");
        assert.equal(fmtTokens(999), "999");
    });
    it("formats thousands as K", () => {
        assert.equal(fmtTokens(1000), "1.0K");
        assert.equal(fmtTokens(45_200), "45.2K");
    });
    it("formats millions as M", () => {
        assert.equal(fmtTokens(1_500_000), "1.5M");
        assert.equal(fmtTokens(1_000_000), "1.0M");
    });
});
describe("fmtDur", () => {
    it("returns 0s for zero", () => {
        assert.equal(fmtDur(0), "0s");
    });
    it("formats seconds only when under a minute", () => {
        assert.equal(fmtDur(30_000), "30s");
        assert.equal(fmtDur(59_999), "59s");
    });
    it("formats minutes and seconds when under an hour", () => {
        assert.equal(fmtDur(90_000), "1m 30s");
        assert.equal(fmtDur(60_000), "1m 0s");
    });
    it("formats hours and minutes for large durations", () => {
        assert.equal(fmtDur(7_200_000), "2h 0m");
        assert.equal(fmtDur(5_430_000), "1h 30m");
    });
});
describe("truncate", () => {
    it("returns short strings unchanged", () => {
        assert.equal(truncate("hi", 10), "hi");
    });
    it("returns string at exact max length unchanged", () => {
        assert.equal(truncate("abcde", 5), "abcde");
    });
    it("truncates with ellipsis when over max", () => {
        assert.equal(truncate("abcdef", 5), "abcd\u2026");
        assert.equal(truncate("hello world", 6), "hello\u2026");
    });
});
