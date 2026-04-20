import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSkillsDb, resetDb, queryRecipeL0 } from "../skills/index-db.js";
import { buildRecipeStub } from "../skills/injection.js";
import * as paths from "../skills/paths.js";

const tmp = join(tmpdir(), "recipe-test-" + Date.now());

beforeEach(() => {
  paths.__setRoot(tmp);
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

// ── buildRecipeStub ──

function seedSkill(fp: string, name: string, desc: string, requiresTools: string[], kind: string): void {
  const db = openSkillsDb();
  db.prepare(`
    INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at, kind)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, fp, desc, '["*"]', '["*"]', JSON.stringify(requiresTools), '["test"]', `canon/${name}.md`, 100, new Date().toISOString(), kind);
}

describe("buildRecipeStub", () => {
  it("returns null when no recipes exist", () => {
    seedSkill("fp1", "test-skill", "Test skill", ["Bash"], "skill");
    resetDb();

    const result = buildRecipeStub({ fingerprint: "fp1", tools: ["Bash"] });
    assert.equal(result, null);
  });

  it("returns recipe stub when recipes match tools", () => {
    seedSkill("fp1", "recipe/test-script", "Run a test script with silent reporter", ["Bash"], "tool-recipe");
    resetDb();

    const result = buildRecipeStub({ fingerprint: "fp1", tools: ["Bash"] });
    assert.ok(result !== null);
    assert.ok(result!.text.includes("## Helpers you've written before (recipes)"));
    assert.ok(result!.text.includes("`recipe/test-script`"));
  });

  it("omits recipes when tools don't match", () => {
    seedSkill("fp1", "recipe/jq-pipeline", "Extract fields from JSON logs", ["jq"], "tool-recipe");
    resetDb();

    // Agent doesn't have jq tool
    const result = buildRecipeStub({ fingerprint: "fp1", tools: ["Bash"] });
    assert.equal(result, null);
  });

  it("returns stub when no tools filter is provided", () => {
    seedSkill("fp1", "recipe/jq-pipeline", "Extract fields from JSON logs", ["jq"], "tool-recipe");
    resetDb();

    const result = buildRecipeStub({ fingerprint: "fp1" });
    assert.ok(result !== null);
    assert.ok(result!.text.includes("`recipe/jq-pipeline`"));
  });
});

// ── queryRecipeL0 ──

describe("queryRecipeL0", () => {
  it("returns only recipes, not skills", () => {
    seedSkill("fp1", "test-skill", "A skill", [], "skill");
    seedSkill("fp1", "recipe/bash-test", "A recipe", [], "tool-recipe");
    resetDb();

    const recipes = queryRecipeL0("fp1", {});
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].name, "recipe/bash-test");
    assert.equal(recipes[0].kind, "tool-recipe");
  });

  it("filters by requires_tools", () => {
    seedSkill("fp1", "recipe/jq-logs", "JQ log pipeline", ["jq"], "tool-recipe");
    seedSkill("fp1", "recipe/bash-only", "Bash script", ["Bash"], "tool-recipe");
    resetDb();

    const withBash = queryRecipeL0("fp1", { availableTools: ["Bash"] });
    assert.equal(withBash.length, 1);
    assert.equal(withBash[0].name, "recipe/bash-only");

    const withBoth = queryRecipeL0("fp1", { availableTools: ["Bash", "jq"] });
    assert.equal(withBoth.length, 2);
  });
});
