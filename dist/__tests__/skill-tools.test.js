import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSkillsDb, resetDb } from "../skills/index-db.js";
import { skillReadTool, skillSearchTool, resetHydrationCounts } from "../skills/tools.js";
import * as paths from "../skills/paths.js";
const tmp = join(tmpdir(), "skill-tools-test-" + Date.now());
const fp = "test-fp-123";
function seedSkill(name, body) {
    const cDir = paths.canonDir(fp);
    mkdirSync(cDir, { recursive: true });
    const relPath = `${fp}/canon/${name}.md`;
    writeFileSync(join(paths.skillsRoot(), relPath), body, "utf-8");
    const db = openSkillsDb();
    db.prepare(`
    INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, fp, `Desc for ${name}`, '["*"]', '["*"]', '[]', '["test"]', relPath, body.length, new Date().toISOString());
}
beforeEach(() => {
    paths.__setRoot(tmp);
    resetDb();
    resetHydrationCounts();
    rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
    resetDb();
    resetHydrationCounts();
    rmSync(tmp, { recursive: true, force: true });
});
describe("skill_read — returns body", () => {
    it("reads skill body and records hydration", () => {
        seedSkill("foo", "# Foo\n\nBody of foo.");
        const result = skillReadTool("foo", fp, "run-1", 1, 0);
        assert.ok(result.ok);
        assert.ok(result.body?.includes("Body of foo."));
    });
});
describe("skill_read — cap enforcement", () => {
    it("sixth call in same wave returns error", () => {
        seedSkill("bar", "# Bar");
        for (let i = 0; i < 5; i++) {
            const r = skillReadTool("bar", fp, "run-1", 1, 1);
            assert.ok(r.ok, `call ${i + 1} should succeed`);
        }
        const sixth = skillReadTool("bar", fp, "run-1", 1, 1);
        assert.ok(!sixth.ok);
        assert.equal(sixth.error, "hydration cap reached; use skill_search to refine");
    });
    it("different wave resets the counter", () => {
        seedSkill("baz", "# Baz");
        for (let i = 0; i < 5; i++)
            skillReadTool("baz", fp, "run-1", 1, 2);
        const nextWave = skillReadTool("baz", fp, "run-1", 2, 2);
        assert.ok(nextWave.ok);
    });
});
describe("skill_read — missing skill", () => {
    it("returns error for nonexistent skill", () => {
        const r = skillReadTool("nope", fp, "run-1", 1, 0);
        assert.ok(!r.ok);
        assert.ok(r.error?.includes("not found"));
    });
});
describe("skill_search — returns matches", () => {
    it("finds skills by description", () => {
        seedSkill("build-check", "# Build\n\nRe-run tsc after dist cleanup.");
        seedSkill("planner-gc", "# GC\n\nDrop merge-failed branches.");
        const results = skillSearchTool("build", fp);
        assert.equal(results.length, 1);
        assert.equal(results[0].name, "build-check");
    });
    it("respects fingerprint filter", () => {
        seedSkill("other-fp", "# Other from different fp.");
        // Insert a skill for a different fingerprint directly
        const db = openSkillsDb();
        db.prepare(`
      INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run("other-skill", "other-fp", "Other skill", '["*"]', '["*"]', '[]', '["x"]', "other/c.md", 10, new Date().toISOString());
        const results = skillSearchTool("Other", fp);
        // Only the one from this fingerprint should match
        const names = results.map(r => r.name);
        assert.ok(!names.includes("other-skill"));
        db.close();
    });
    it("returns at most 5 results", () => {
        for (let i = 0; i < 7; i++)
            seedSkill(`search-${i}`, `# S${i}\n\nA common search term.`);
        const results = skillSearchTool("common", fp);
        assert.ok(results.length <= 5);
    });
});
