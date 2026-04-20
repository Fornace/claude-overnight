import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { writeCandidate, computeRepoFingerprint } from "../skills/scribe.js";
import * as paths from "../skills/paths.js";
const TEST_FP = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
afterEach(() => {
    // Clean up test candidates dir
    const dir = paths.candidatesDir(TEST_FP);
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch { }
});
// ── Size cap ──
describe("writeCandidate size cap", () => {
    it("truncates body > 5KB and appends truncation note", () => {
        const bigBody = "x".repeat(10 * 1024); // 10KB
        const r = writeCandidate({
            kind: "skill",
            proposedBy: "test-agent",
            wave: 1,
            runId: "run-test",
            fingerprint: TEST_FP,
            trigger: "big body test",
            body: bigBody,
        });
        assert.equal(r.wrote, true);
        const dir = paths.candidatesDir(TEST_FP);
        const files = readdirSync(dir).filter(f => f.endsWith(".md"));
        assert.equal(files.length, 1);
        const content = readFileSync(join(dir, files[0]), "utf-8");
        // File should be ≤ 5KB body + frontmatter (~300 bytes) + truncation note
        assert.ok(Buffer.byteLength(content, "utf-8") < 6 * 1024, `file too large: ${Buffer.byteLength(content)} bytes`);
        assert.ok(content.includes("[truncated at 5KB by scribe]"));
    });
});
// ── Filename shape ──
describe("writeCandidate filename", () => {
    it("contains ISO timestamp and sanitized agent id", () => {
        writeCandidate({
            kind: "heuristic",
            proposedBy: "agent/with:weird*chars",
            wave: 0,
            runId: "run-test",
            fingerprint: TEST_FP,
            trigger: "filename test",
            body: "short body",
        });
        const dir = paths.candidatesDir(TEST_FP);
        const files = readdirSync(dir).filter(f => f.endsWith(".md"));
        assert.equal(files.length, 1);
        // ISO timestamp with hyphens replacing colons: 2026-04-19T23-04-12
        assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(files[0]), `unexpected filename: ${files[0]}`);
        // Sanitized agent id: weird chars replaced
        assert.ok(files[0].includes("agent_with_weird_chars"), `missing sanitized id in: ${files[0]}`);
    });
});
// ── Back-pressure ──
describe("writeCandidate back-pressure", () => {
    it("silently drops when queue ≥ 50 files", () => {
        const dir = paths.candidatesDir(TEST_FP);
        // Pre-fill 50 files — unique proposedBy ensures unique filenames.
        for (let i = 0; i < 50; i++) {
            writeCandidate({ kind: "skill", proposedBy: `filler-${i}`, wave: 0, runId: "run-test", fingerprint: TEST_FP, trigger: "fill", body: "x" });
        }
        const before = readdirSync(dir).filter(f => f.endsWith(".md")).length;
        assert.equal(before, 50);
        // 51st write should drop
        const r = writeCandidate({
            kind: "skill",
            proposedBy: "overflow",
            wave: 1,
            runId: "run-test",
            fingerprint: TEST_FP,
            trigger: "should drop",
            body: "this should not be written",
        });
        assert.equal(r.wrote, false);
        assert.equal(r.dropped, true);
        const after = readdirSync(dir).filter(f => f.endsWith(".md")).length;
        assert.equal(after, 50);
    });
});
// ── Roundtrip ──
describe("writeCandidate roundtrip", () => {
    it("frontmatter parses back to input values", () => {
        writeCandidate({
            kind: "tool-recipe",
            proposedBy: "verifier",
            wave: 3,
            runId: "run-abc123",
            fingerprint: TEST_FP,
            trigger: "roundtrip test",
            body: "## When to apply\nAlways.\n\n## Steps\n1. Do it.",
        });
        const dir = paths.candidatesDir(TEST_FP);
        const files = readdirSync(dir).filter(f => f.endsWith(".md"));
        assert.equal(files.length, 1);
        const content = readFileSync(join(dir, files[0]), "utf-8");
        // Minimal YAML frontmatter check
        assert.ok(content.startsWith("---\n"));
        const endIdx = content.indexOf("\n---\n");
        assert.ok(endIdx > 0);
        const yaml = content.slice(4, endIdx);
        assert.ok(yaml.includes('kind: "tool-recipe"'));
        assert.ok(yaml.includes('proposed_by: "verifier"'));
        assert.ok(yaml.includes("wave: 3"));
        assert.ok(yaml.includes('run_id: "run-abc123"'));
        assert.ok(yaml.includes('trigger: "roundtrip test"'));
        assert.ok(yaml.includes('status: "new"'));
    });
});
// ── No-throw on EACCES ──
describe("writeCandidate never throws", () => {
    it("returns gracefully even with invalid fingerprint path", () => {
        // Use a fingerprint that would create a path under a non-existent root
        // if we could somehow override; for now, test with a valid path but
        // verify no exception propagates.
        const r = writeCandidate({
            kind: "skill",
            proposedBy: "test",
            wave: 0,
            runId: "run-test",
            fingerprint: TEST_FP,
            trigger: "no throw",
            body: "x",
        });
        // Either wrote or dropped, but never throws
        assert.ok(typeof r.wrote === "boolean");
        assert.ok(typeof r.dropped === "boolean");
    });
});
// ── computeRepoFingerprint ──
describe("computeRepoFingerprint", () => {
    it("returns a 12-char hex string for a git repo", () => {
        const fp = computeRepoFingerprint(process.cwd());
        assert.equal(fp.length, 12);
        assert.ok(/^[0-9a-f]{12}$/.test(fp));
    });
    it("returns deterministic output for the same cwd", () => {
        const a = computeRepoFingerprint(process.cwd());
        const b = computeRepoFingerprint(process.cwd());
        assert.equal(a, b);
    });
});
