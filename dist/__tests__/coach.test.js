import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolveCoachSkillPath, validateCoachOutput } from "../planner/coach/coach.js";
function validPayload(overrides = {}) {
    return {
        scope: "bugfix",
        improvedObjective: "Fix password reset: emails not sending.\nDone: reset email arrives within 10s.\nCritical: don't touch Stripe webhooks.\nVerify by: trigger reset flow end-to-end.",
        rationale: "Narrowed the objective to one symptom and a verification path.",
        recommended: {
            budget: 12,
            concurrency: 4,
            plannerModel: "claude-sonnet-4-6",
            workerModel: "claude-sonnet-4-6",
            fastModel: null,
            flex: true,
            usageCap: 0.75,
            permissionMode: "auto",
        },
        checklist: [
            { id: "anthropic-key", level: "info", title: "ANTHROPIC_API_KEY set", detail: "", remediation: "none" },
            { id: "dirty-tree", level: "warning", title: "git has untracked changes", detail: "4 files", remediation: "git:dirty" },
        ],
        questions: [],
        ...overrides,
    };
}
describe("coach skill resolution", () => {
    it("resolves SKILL.md to an existing file", () => {
        const p = resolveCoachSkillPath();
        assert.ok(p, "expected a path");
        assert.ok(existsSync(p), `SKILL.md not found at ${p}`);
        const body = readFileSync(p, "utf-8");
        assert.match(body, /^---/, "expected frontmatter");
        assert.match(body, /Invocation contract/, "expected invocation contract section");
    });
});
describe("validateCoachOutput", () => {
    it("accepts a well-formed payload", () => {
        const result = validateCoachOutput(validPayload());
        assert.ok(result, "expected a CoachResult");
        assert.equal(result.scope, "bugfix");
        assert.equal(result.recommended.budget, 12);
        assert.equal(result.recommended.concurrency, 4);
        assert.equal(result.recommended.fastModel, null);
        assert.equal(result.recommended.usageCap, 0.75);
        assert.equal(result.checklist.length, 2);
    });
    it("returns null when scope is missing", () => {
        const bad = validPayload();
        delete bad.scope;
        assert.equal(validateCoachOutput(bad), null);
    });
    it("returns null when scope is unknown", () => {
        assert.equal(validateCoachOutput(validPayload({ scope: "magic" })), null);
    });
    it("returns null when recommended.budget is negative", () => {
        const bad = validPayload();
        bad.recommended.budget = -1;
        assert.equal(validateCoachOutput(bad), null);
    });
    it("returns null when recommended.concurrency exceeds 12", () => {
        const bad = validPayload();
        bad.recommended.concurrency = 99;
        assert.equal(validateCoachOutput(bad), null);
    });
    it("returns null when permissionMode is invalid", () => {
        const bad = validPayload();
        bad.recommended.permissionMode = "yolo";
        assert.equal(validateCoachOutput(bad), null);
    });
    it("coerces usageCap out of range to null", () => {
        const bad = validPayload();
        bad.recommended.usageCap = 5;
        const r = validateCoachOutput(bad);
        assert.ok(r);
        assert.equal(r.recommended.usageCap, null);
    });
    it("drops checklist items with invalid shape", () => {
        const payload = validPayload();
        payload.checklist.push({ id: "x", level: "nuke", title: "t", detail: "d", remediation: "none" });
        const r = validateCoachOutput(payload);
        assert.ok(r);
        assert.equal(r.checklist.length, 2);
    });
    it("maps unknown remediation slug to none", () => {
        const payload = validPayload({
            checklist: [{ id: "x", level: "info", title: "t", detail: "d", remediation: "bogus" }],
        });
        const r = validateCoachOutput(payload);
        assert.ok(r);
        assert.equal(r.checklist[0].remediation, "none");
    });
    it("returns null for non-object input", () => {
        assert.equal(validateCoachOutput(null), null);
        assert.equal(validateCoachOutput("string"), null);
        assert.equal(validateCoachOutput(42), null);
    });
});
