import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSkillsDb, queryCandidateL0, recordEvent, incrementUse, resetDb } from "../skills/index-db.js";
import * as paths from "../skills/paths.js";
const tmp = join(tmpdir(), "skills-index-test-" + Date.now());
beforeEach(() => {
    paths.__setRoot(tmp);
    resetDb();
    rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
    resetDb();
    rmSync(tmp, { recursive: true, force: true });
    paths.__restoreRoot();
});
describe("index-db — open + migrate", () => {
    it("creates the database file on open", () => {
        const db = openSkillsDb();
        assert.ok(existsSync(join(tmp, "index.sqlite")));
        db.close();
    });
    it("is idempotent — second open returns same handle", () => {
        const db1 = openSkillsDb();
        const db2 = openSkillsDb();
        assert.strictEqual(db1, db2);
        db1.close();
    });
});
describe("index-db — insert + query", () => {
    it("returns skills for matching fingerprint", () => {
        const db = openSkillsDb();
        db.prepare(`
      INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 100, ?)
    `).run("test-skill", "abc123456789", "A test skill", '["typescript"]', '["npm"]', '[]', '["test"]', "canon/test-skill.md", new Date().toISOString());
        const rows = queryCandidateL0("abc123456789", {});
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, "test-skill");
        db.close();
    });
    it("filters by requires_tools", () => {
        const db = openSkillsDb();
        db.prepare(`
      INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 100, ?)
    `).run("needs-npm", "fp1", "Needs npm", '["typescript"]', '["npm"]', '["npm"]', '["build"]', "canon/needs-npm.md", new Date().toISOString());
        // Has npm tool — should match
        const withNpm = queryCandidateL0("fp1", { availableTools: ["npm", "Read"] });
        assert.equal(withNpm.length, 1);
        // No npm tool — should NOT match
        const withoutNpm = queryCandidateL0("fp1", { availableTools: ["Read", "Grep"] });
        assert.equal(withoutNpm.length, 0);
        db.close();
    });
    it("excludes quarantined skills", () => {
        const db = openSkillsDb();
        db.prepare(`
      INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at, quarantined)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 100, ?, 1)
    `).run("quarantined-skill", "fp2", "Quarantined", '["*"]', '["*"]', '[]', '["x"]', "canon/q.md", new Date().toISOString());
        const rows = queryCandidateL0("fp2", {});
        assert.equal(rows.length, 0);
        db.close();
    });
});
describe("index-db — FTS5", () => {
    it("FTS5 triggers populate on insert", () => {
        const db = openSkillsDb();
        db.prepare(`
      INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 100, ?)
    `).run("searchable", "fp3", "Search me", '["*"]', '["*"]', '[]', '["search", "find"]', "canon/searchable.md", new Date().toISOString());
        const results = db.prepare("SELECT rowid, name, rank FROM skills_fts WHERE skills_fts MATCH ? ORDER BY rank LIMIT 5").all("search");
        assert.equal(results.length, 1);
        assert.equal(results[0].name, "searchable");
        db.close();
    });
});
describe("index-db — events + incrementUse", () => {
    it("recordEvent inserts a row", () => {
        openSkillsDb();
        recordEvent("run-1", 3, "my-skill", "hydrated");
        const db = openSkillsDb();
        const count = db.prepare("SELECT COUNT(*) as c FROM skill_events WHERE skill_name = ?").get("my-skill").c;
        assert.equal(count, 1);
        db.close();
    });
    it("incrementUse bumps uses and last_used_at", () => {
        const db = openSkillsDb();
        db.prepare(`
      INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 100, ?)
    `).run("inc-skill", "fp4", "Inc", '["*"]', '["*"]', '[]', '["x"]', "canon/inc.md", new Date().toISOString());
        incrementUse("inc-skill");
        const row = db.prepare("SELECT uses, last_used_at FROM skills WHERE name = ?").get("inc-skill");
        assert.equal(row.uses, 1);
        assert.ok(row.last_used_at != null);
        db.close();
    });
});
