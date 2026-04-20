import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { pickAbSkill, recordAbOutcome } from "../skills/ab.js";
import { openSkillsDb, resetDb } from "../skills/index-db.js";
import { indexPath } from "../skills/paths.js";
function wipeDbFile() {
    const p = indexPath();
    if (existsSync(p))
        rmSync(p, { recursive: true });
    // Also remove WAL/SHM files
    if (existsSync(p + "-wal"))
        rmSync(p + "-wal");
    if (existsSync(p + "-shm"))
        rmSync(p + "-shm");
}
const NOW = new Date().toISOString();
function seedSkill(db, name, fp, abEligible = 1, quarantined = 0) {
    db.prepare(`INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at, ab_eligible, quarantined)
     VALUES (?, ?, ?, 1, '[]', '[]', '[]', '[]', '/dev/null', 0, ?, ?, ?)`).run(name, fp, `desc ${name}`, NOW, abEligible, quarantined);
}
describe("ab — pickAbSkill", () => {
    beforeEach(() => { resetDb(); wipeDbFile(); });
    afterEach(() => { resetDb(); });
    it("returns null when no eligible skills", () => {
        const tasks = [
            { id: "a", prompt: "task a" },
            { id: "b", prompt: "task b" },
        ];
        assert.strictEqual(pickAbSkill({ fingerprint: "fp-noskill", tasks, wave: 0 }), null);
    });
    it("returns null when fewer than 2 tasks", () => {
        seedSkill(openSkillsDb(), "seed-fewer2", "fp-fewer2");
        const tasks = [{ id: "a", prompt: "only one" }];
        assert.strictEqual(pickAbSkill({ fingerprint: "fp-fewer2", tasks, wave: 0 }), null);
    });
    it("assigns treatment and control arms", () => {
        seedSkill(openSkillsDb(), "seed-assign", "fp-assign");
        const tasks = [
            { id: "a", prompt: "task a" },
            { id: "b", prompt: "task b" },
        ];
        const result = pickAbSkill({ fingerprint: "fp-assign", tasks, wave: 0 });
        assert.ok(result);
        assert.strictEqual(result.skill, "seed-assign");
        assert.strictEqual(result.treatmentTaskIds.length, 1);
        assert.strictEqual(result.controlTaskIds.length, 1);
        const treatmentTask = tasks.find(t => t.id === result.treatmentTaskIds[0]);
        const controlTask = tasks.find(t => t.id === result.controlTaskIds[0]);
        assert.strictEqual(treatmentTask?.abArm, "treatment");
        assert.strictEqual(controlTask?.abArm, "control");
        assert.strictEqual(controlTask?.abExcludeSkill, "seed-assign");
    });
    it("prefers same-group tasks for pairing", () => {
        seedSkill(openSkillsDb(), "seed-group", "fp-group");
        const tasks = [
            { id: "a", prompt: "a", groupId: "g1" },
            { id: "b", prompt: "b", groupId: "g1" },
            { id: "c", prompt: "c", groupId: "g2" },
            { id: "d", prompt: "d" },
        ];
        const result = pickAbSkill({ fingerprint: "fp-group", tasks, wave: 1 });
        assert.ok(result);
        const allIds = [...result.treatmentTaskIds, ...result.controlTaskIds];
        assert.ok(allIds.includes("a") && allIds.includes("b"));
    });
    it("skips quarantined skills", () => {
        const db = openSkillsDb();
        seedSkill(db, "seed-quar", "fp-quar", 1, 1);
        seedSkill(db, "seed-active", "fp-quar", 1, 0);
        const tasks = [
            { id: "a", prompt: "a" },
            { id: "b", prompt: "b" },
        ];
        const result = pickAbSkill({ fingerprint: "fp-quar", tasks, wave: 0 });
        assert.ok(result);
        assert.strictEqual(result.skill, "seed-active");
    });
});
describe("ab — recordAbOutcome", () => {
    beforeEach(() => { resetDb(); wipeDbFile(); openSkillsDb(); });
    afterEach(() => { resetDb(); });
    it("records win when treatment scores higher", () => {
        const a = mkAssignment("win-skill");
        recordAbOutcome({
            runId: "r1", wave: 0, assignment: a,
            treatmentScore: 1, controlScore: 0,
            treatmentFilesChanged: 3, controlFilesChanged: 0,
            treatmentCostUsd: 0.50, controlCostUsd: 0.60,
        });
        const rows = recordRows("win-skill");
        // win + cost_saved (treatment won AND spent less)
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].event, "win");
        assert.ok(rows[0].notes.includes("ab-vs"));
    });
    it("records loss when control scores higher", () => {
        const a = mkAssignment("loss-skill");
        recordAbOutcome({
            runId: "r2", wave: 0, assignment: a,
            treatmentScore: 0, controlScore: 1,
            treatmentFilesChanged: 0, controlFilesChanged: 2,
            treatmentCostUsd: 0.80, controlCostUsd: 0.40,
        });
        const rows = recordRows("loss-skill");
        assert.ok(rows.some(r => r.event === "loss"));
    });
    it("records tie when both score equally", () => {
        const a = mkAssignment("tie-skill");
        recordAbOutcome({
            runId: "r3", wave: 0, assignment: a,
            treatmentScore: 1, controlScore: 1,
            treatmentFilesChanged: 3, controlFilesChanged: 3,
            treatmentCostUsd: 0.50, controlCostUsd: 0.50,
        });
        const rows = recordRows("tie-skill");
        const tie = rows.find(r => r.event === "tie");
        assert.ok(tie);
        assert.strictEqual(tie.notes, "ab-inconclusive");
    });
    it("records cost_saved when treatment wins AND costs less", () => {
        const a = mkAssignment("saved-skill");
        recordAbOutcome({
            runId: "r4", wave: 0, assignment: a,
            treatmentScore: 1, controlScore: 0,
            treatmentFilesChanged: 3, controlFilesChanged: 0,
            treatmentCostUsd: 0.30, controlCostUsd: 0.70,
        });
        const rows = recordRows("saved-skill");
        const cost = rows.find(r => r.event === "cost_saved");
        assert.ok(cost);
        assert.ok(Math.abs(cost.value - 0.4) < 0.001);
    });
    it("records cost_burned when treatment loses AND costs more", () => {
        const a = mkAssignment("burned-skill");
        recordAbOutcome({
            runId: "r5", wave: 0, assignment: a,
            treatmentScore: 0, controlScore: 1,
            treatmentFilesChanged: 0, controlFilesChanged: 2,
            treatmentCostUsd: 0.90, controlCostUsd: 0.30,
        });
        const rows = recordRows("burned-skill");
        const cost = rows.find(r => r.event === "cost_burned");
        assert.ok(cost);
        assert.ok(Math.abs(cost.value - 0.6) < 0.001);
    });
    it("clamps cost values to $2.00", () => {
        const a = mkAssignment("clamp-skill");
        recordAbOutcome({
            runId: "r6", wave: 0, assignment: a,
            treatmentScore: 0, controlScore: 1,
            treatmentFilesChanged: 0, controlFilesChanged: 2,
            treatmentCostUsd: 5.00, controlCostUsd: 0.10,
        });
        const rows = recordRows("clamp-skill");
        const cost = rows.find(r => r.event === "cost_burned");
        assert.ok(cost);
        assert.strictEqual(cost.value, 2.0);
    });
    it("ties produce no cost attribution", () => {
        const a = mkAssignment("nocost-skill");
        recordAbOutcome({
            runId: "r7", wave: 0, assignment: a,
            treatmentScore: 0, controlScore: 0,
            treatmentFilesChanged: 0, controlFilesChanged: 0,
            treatmentCostUsd: 1.00, controlCostUsd: 0.50,
        });
        const rows = recordRows("nocost-skill");
        const costRows = rows.filter(r => r.event.startsWith("cost_"));
        assert.strictEqual(costRows.length, 0);
    });
});
function mkAssignment(skill) {
    return { skill, treatmentTaskIds: ["t1"], controlTaskIds: ["c1"], wave: 0 };
}
function recordRows(skill) {
    const db = openSkillsDb();
    return db.prepare("SELECT * FROM skill_events WHERE skill_name = ? ORDER BY rowid").all(skill);
}
