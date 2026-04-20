import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { openSkillsDb, resetDb } from "../skills/index-db.js";
import * as paths from "../skills/paths.js";
import { runLibrarian } from "../skills/librarian.js";
const tmp = join(tmpdir(), "librarian-fetch-test-" + Date.now());
const FP = "fp-fetch";
async function withMockServer(reply, fn) {
    const captured = [];
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c.toString(); });
        req.on("end", () => {
            const cap = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) };
            captured.push(cap);
            const { status, body } = reply(cap);
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(body));
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
        await fn(port, captured);
    }
    finally {
        await new Promise((r) => server.close(() => r()));
    }
}
function seedCandidate(body = "# heuristic\nuse this skill when the task involves X") {
    const dir = paths.candidatesDir(FP);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(dir, "cand-001.md"), `---
name: "cand-001"
kind: "skill"
proposed_by: "thinking-wave-1"
wave: 1
trigger: "test"
created_at: "${now}"
---
${body}`, "utf-8");
}
beforeEach(() => {
    paths.__setRoot(tmp);
    resetDb();
    rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
    resetDb();
    rmSync(tmp, { recursive: true, force: true });
});
describe("librarian fetch — direct POST to /v1/messages", () => {
    it("POSTs to proxied base url with Bearer and applies returned actions", async () => {
        seedCandidate();
        const actions = [{
                action: "create",
                name: "new-skill-1",
                description: "created by librarian via direct fetch",
                triggers: ["alpha", "beta"],
                requires_tools: [],
                languages: ["ts"],
                toolsets: ["npm"],
                body: "# new-skill-1\ndo the thing",
            }];
        await withMockServer(() => ({ status: 200, body: { content: [{ type: "text", text: JSON.stringify(actions) }] } }), async (port, captured) => {
            const result = await runLibrarian({
                fingerprint: FP, runId: "r1", wave: 1, cwd: tmp, model: "composer-2",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "secret-bridge" }),
            });
            assert.equal(captured.length, 1, "exactly one POST made");
            assert.equal(captured[0].url, "/v1/messages");
            assert.equal(captured[0].headers["authorization"], "Bearer secret-bridge");
            assert.equal(captured[0].body.model, "composer-2");
            assert.ok(Array.isArray(captured[0].body.messages));
            assert.equal(result.promoted, 1);
            assert.equal(result.patched, 0);
            const mdPath = join(paths.canonDir(FP), "new-skill-1.md");
            assert.ok(existsSync(mdPath), "canon md created");
            const db = openSkillsDb();
            const row = db.prepare("SELECT name, description FROM skills WHERE name = ?").get("new-skill-1");
            assert.equal(row?.name, "new-skill-1");
        });
    });
    it("falls back to x-api-key when env has ANTHROPIC_API_KEY and no bearer", async () => {
        seedCandidate();
        await withMockServer(() => ({ status: 200, body: { content: [{ type: "text", text: "[]" }] } }), async (port, captured) => {
            await runLibrarian({
                fingerprint: FP, runId: "r1", wave: 1, cwd: tmp, model: "claude-sonnet-4-6",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-test-123" }),
            });
            assert.equal(captured.length, 1);
            assert.equal(captured[0].headers["authorization"], undefined);
            assert.equal(captured[0].headers["x-api-key"], "sk-test-123");
        });
    });
    it("strips markdown code fences around JSON response", async () => {
        seedCandidate();
        const actions = [{ action: "reject_candidate", candidate_file: "cand-001.md", reason: "duplicate of canon" }];
        const fenced = "```json\n" + JSON.stringify(actions) + "\n```";
        await withMockServer(() => ({ status: 200, body: { content: [{ type: "text", text: fenced }] } }), async (port) => {
            const result = await runLibrarian({
                fingerprint: FP, runId: "r1", wave: 1, cwd: tmp, model: "composer-2",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "t" }),
            });
            assert.equal(result.rejected, 1);
        });
    });
    it("returns empty result and does not throw on HTTP 500", async () => {
        seedCandidate();
        await withMockServer(() => ({ status: 500, body: { error: "upstream exploded" } }), async (port) => {
            const result = await runLibrarian({
                fingerprint: FP, runId: "r1", wave: 1, cwd: tmp, model: "qwen3.6-plus",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "t" }),
            });
            assert.equal(result.promoted, 0);
            assert.equal(result.patched, 0);
            assert.equal(result.rejected, 0);
        });
    });
    it("returns empty result when response is not valid JSON", async () => {
        seedCandidate();
        await withMockServer(() => ({ status: 200, body: { content: [{ type: "text", text: "I am not JSON, sorry." }] } }), async (port) => {
            const result = await runLibrarian({
                fingerprint: FP, runId: "r1", wave: 1, cwd: tmp, model: "composer-2",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "t" }),
            });
            assert.equal(result.promoted, 0);
        });
    });
    it("does nothing when there are no candidates (no HTTP call)", async () => {
        await withMockServer(() => ({ status: 200, body: { content: [{ type: "text", text: "[]" }] } }), async (port, captured) => {
            const result = await runLibrarian({
                fingerprint: FP, runId: "r1", wave: 1, cwd: tmp, model: "composer-2",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "t" }),
            });
            assert.equal(captured.length, 0, "no HTTP call without candidates");
            assert.equal(result.promoted, 0);
        });
    });
    it("archives candidates after successful run", async () => {
        seedCandidate();
        await withMockServer(() => ({ status: 200, body: { content: [{ type: "text", text: "[]" }] } }), async (port) => {
            await runLibrarian({
                fingerprint: FP, runId: "r-archive", wave: 1, cwd: tmp, model: "composer-2",
                envForModel: () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "t" }),
            });
            const srcDir = paths.candidatesDir(FP);
            const destDir = join(paths.skillsRoot(), FP, "processed", "r-archive");
            assert.ok(!existsSync(join(srcDir, "cand-001.md")), "candidate removed from src");
            assert.ok(existsSync(join(destDir, "cand-001.md")), "candidate archived to processed");
        });
    });
});
