import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const KNOWN_TASK_FILE_KEYS = new Set([
    "tasks", "objective", "concurrency", "cwd", "model", "allowedTools", "worktrees", "mergeStrategy", "usageCap", "flexiblePlan",
]);
function validateConcurrency(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`Concurrency must be a positive integer (got ${JSON.stringify(value)})`);
    }
}
function loadTaskFile(file) {
    const path = resolve(file);
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch {
        throw new Error(`Cannot read task file: ${path}`);
    }
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch {
        throw new Error(`Task file is not valid JSON: ${path}`);
    }
    const parsed = Array.isArray(json) ? { tasks: json } : json;
    if (!Array.isArray(json) && typeof json === "object" && json !== null) {
        const unknown = Object.keys(json).filter((k) => !KNOWN_TASK_FILE_KEYS.has(k));
        if (unknown.length > 0) {
            throw new Error(`Unknown key${unknown.length > 1 ? "s" : ""} in task file: ${unknown.join(", ")}. ` +
                `Allowed: ${[...KNOWN_TASK_FILE_KEYS].join(", ")}`);
        }
    }
    if (!Array.isArray(parsed.tasks)) {
        throw new Error(`Task file must contain a "tasks" array (got ${typeof parsed.tasks})`);
    }
    const tasks = [];
    for (let i = 0; i < parsed.tasks.length; i++) {
        const t = parsed.tasks[i];
        const id = String(tasks.length);
        if (typeof t === "string") {
            if (!t.trim())
                throw new Error(`Task ${i} is an empty string`);
            tasks.push({ id, prompt: t });
        }
        else if (typeof t === "object" && t !== null) {
            if (typeof t.prompt !== "string" || !t.prompt.trim()) {
                throw new Error(`Task ${i} is missing a "prompt" string`);
            }
            tasks.push({ id, prompt: t.prompt, cwd: t.cwd ? resolve(t.cwd) : undefined, model: t.model });
        }
        else {
            throw new Error(`Task ${i} must be a string or object with a "prompt" field (got ${typeof t})`);
        }
    }
    if (parsed.concurrency !== undefined) {
        validateConcurrency(parsed.concurrency);
    }
    return {
        tasks,
        concurrency: parsed.concurrency,
        model: parsed.model,
        cwd: parsed.cwd ? resolve(parsed.cwd) : undefined,
        allowedTools: parsed.allowedTools,
        useWorktrees: parsed.worktrees,
    };
}
// ── Test helpers ──
let tmpDir;
function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "validation-test-"));
    return tmpDir;
}
function teardown() {
    if (tmpDir)
        rmSync(tmpDir, { recursive: true, force: true });
}
function writeTempJson(name, content) {
    const p = join(tmpDir, name);
    writeFileSync(p, JSON.stringify(content));
    return p;
}
// ── Tests ──
describe("loadTaskFile validation", () => {
    describe("valid JSON array (shorthand)", () => {
        it("parses a bare array of strings into tasks", () => {
            setup();
            try {
                const file = writeTempJson("array.json", ["do thing A", "do thing B"]);
                const result = loadTaskFile(file);
                assert.strictEqual(result.tasks.length, 2);
                assert.strictEqual(result.tasks[0].prompt, "do thing A");
                assert.strictEqual(result.tasks[0].id, "0");
                assert.strictEqual(result.tasks[1].prompt, "do thing B");
                assert.strictEqual(result.tasks[1].id, "1");
                assert.strictEqual(result.concurrency, undefined);
            }
            finally {
                teardown();
            }
        });
        it("parses a bare array of objects into tasks", () => {
            setup();
            try {
                const file = writeTempJson("array-obj.json", [
                    { prompt: "first" },
                    { prompt: "second", model: "opus" },
                ]);
                const result = loadTaskFile(file);
                assert.strictEqual(result.tasks.length, 2);
                assert.strictEqual(result.tasks[0].prompt, "first");
                assert.strictEqual(result.tasks[1].model, "opus");
            }
            finally {
                teardown();
            }
        });
    });
    describe("valid JSON object", () => {
        it("parses an object with tasks array", () => {
            setup();
            try {
                const file = writeTempJson("obj.json", {
                    tasks: ["prompt A"],
                    concurrency: 3,
                    model: "sonnet",
                });
                const result = loadTaskFile(file);
                assert.strictEqual(result.tasks.length, 1);
                assert.strictEqual(result.tasks[0].prompt, "prompt A");
                assert.strictEqual(result.concurrency, 3);
                assert.strictEqual(result.model, "sonnet");
            }
            finally {
                teardown();
            }
        });
        it("passes through all known optional fields", () => {
            setup();
            try {
                const file = writeTempJson("full.json", {
                    tasks: ["go"],
                    concurrency: 2,
                    model: "haiku",
                    allowedTools: ["Bash", "Read"],
                    worktrees: true,
                });
                const result = loadTaskFile(file);
                assert.deepStrictEqual(result.allowedTools, ["Bash", "Read"]);
                assert.strictEqual(result.useWorktrees, true);
            }
            finally {
                teardown();
            }
        });
    });
    describe("missing tasks key", () => {
        it("throws when object has no tasks property", () => {
            setup();
            try {
                const file = writeTempJson("no-tasks.json", { concurrency: 2 });
                assert.throws(() => loadTaskFile(file), { message: /must contain a "tasks" array/ });
            }
            finally {
                teardown();
            }
        });
        it("throws when tasks is not an array", () => {
            setup();
            try {
                const file = writeTempJson("tasks-string.json", { tasks: "not an array" });
                assert.throws(() => loadTaskFile(file), { message: /must contain a "tasks" array \(got string\)/ });
            }
            finally {
                teardown();
            }
        });
    });
    describe("empty tasks array", () => {
        it("returns zero tasks without error", () => {
            setup();
            try {
                const file = writeTempJson("empty.json", { tasks: [] });
                const result = loadTaskFile(file);
                assert.strictEqual(result.tasks.length, 0);
            }
            finally {
                teardown();
            }
        });
        it("returns zero tasks for bare empty array", () => {
            setup();
            try {
                const file = writeTempJson("bare-empty.json", []);
                const result = loadTaskFile(file);
                assert.strictEqual(result.tasks.length, 0);
            }
            finally {
                teardown();
            }
        });
    });
    describe("task with empty string", () => {
        it("throws on empty string task", () => {
            setup();
            try {
                const file = writeTempJson("empty-str.json", ["valid", ""]);
                assert.throws(() => loadTaskFile(file), { message: /Task 1 is an empty string/ });
            }
            finally {
                teardown();
            }
        });
        it("throws on whitespace-only string task", () => {
            setup();
            try {
                const file = writeTempJson("ws.json", ["  \t\n  "]);
                assert.throws(() => loadTaskFile(file), { message: /Task 0 is an empty string/ });
            }
            finally {
                teardown();
            }
        });
    });
    describe("task object missing prompt", () => {
        it("throws when prompt key is absent", () => {
            setup();
            try {
                const file = writeTempJson("no-prompt.json", [{ cwd: "/tmp" }]);
                assert.throws(() => loadTaskFile(file), { message: /Task 0 is missing a "prompt" string/ });
            }
            finally {
                teardown();
            }
        });
        it("throws when prompt is empty string", () => {
            setup();
            try {
                const file = writeTempJson("empty-prompt.json", [{ prompt: "" }]);
                assert.throws(() => loadTaskFile(file), { message: /Task 0 is missing a "prompt" string/ });
            }
            finally {
                teardown();
            }
        });
        it("throws when prompt is whitespace-only", () => {
            setup();
            try {
                const file = writeTempJson("ws-prompt.json", [{ prompt: "   " }]);
                assert.throws(() => loadTaskFile(file), { message: /Task 0 is missing a "prompt" string/ });
            }
            finally {
                teardown();
            }
        });
        it("throws when prompt is a number instead of string", () => {
            setup();
            try {
                const file = writeTempJson("num-prompt.json", [{ prompt: 42 }]);
                assert.throws(() => loadTaskFile(file), { message: /Task 0 is missing a "prompt" string/ });
            }
            finally {
                teardown();
            }
        });
    });
    describe("unknown keys", () => {
        it("throws on a single unknown key", () => {
            setup();
            try {
                const file = writeTempJson("unk1.json", { tasks: ["go"], foo: true });
                assert.throws(() => loadTaskFile(file), { message: /Unknown key in task file: foo/ });
            }
            finally {
                teardown();
            }
        });
        it("throws on multiple unknown keys with plural message", () => {
            setup();
            try {
                const file = writeTempJson("unk2.json", { tasks: ["go"], foo: 1, bar: 2 });
                assert.throws(() => loadTaskFile(file), { message: /Unknown keys in task file: foo, bar/ });
            }
            finally {
                teardown();
            }
        });
        it("lists allowed keys in the error message", () => {
            setup();
            try {
                const file = writeTempJson("unk3.json", { tasks: ["go"], nope: true });
                assert.throws(() => loadTaskFile(file), { message: /Allowed:/ });
            }
            finally {
                teardown();
            }
        });
        it("does not reject unknown keys for bare arrays", () => {
            setup();
            try {
                // Arrays skip the unknown-keys check entirely
                const file = writeTempJson("array-ok.json", ["task1"]);
                const result = loadTaskFile(file);
                assert.strictEqual(result.tasks.length, 1);
            }
            finally {
                teardown();
            }
        });
    });
    describe("invalid concurrency", () => {
        it("throws on zero", () => {
            setup();
            try {
                const file = writeTempJson("c0.json", { tasks: ["go"], concurrency: 0 });
                assert.throws(() => loadTaskFile(file), { message: /Concurrency must be a positive integer \(got 0\)/ });
            }
            finally {
                teardown();
            }
        });
        it("throws on negative number", () => {
            setup();
            try {
                const file = writeTempJson("cneg.json", { tasks: ["go"], concurrency: -3 });
                assert.throws(() => loadTaskFile(file), { message: /Concurrency must be a positive integer \(got -3\)/ });
            }
            finally {
                teardown();
            }
        });
        it("throws on float", () => {
            setup();
            try {
                const file = writeTempJson("cfloat.json", { tasks: ["go"], concurrency: 2.5 });
                assert.throws(() => loadTaskFile(file), { message: /Concurrency must be a positive integer \(got 2\.5\)/ });
            }
            finally {
                teardown();
            }
        });
        it("throws on string", () => {
            setup();
            try {
                const file = writeTempJson("cstr.json", { tasks: ["go"], concurrency: "4" });
                assert.throws(() => loadTaskFile(file), { message: /Concurrency must be a positive integer \(got "4"\)/ });
            }
            finally {
                teardown();
            }
        });
        it("accepts valid positive integer", () => {
            setup();
            try {
                const file = writeTempJson("cok.json", { tasks: ["go"], concurrency: 5 });
                const result = loadTaskFile(file);
                assert.strictEqual(result.concurrency, 5);
            }
            finally {
                teardown();
            }
        });
        it("skips validation when concurrency is omitted", () => {
            setup();
            try {
                const file = writeTempJson("cno.json", { tasks: ["go"] });
                const result = loadTaskFile(file);
                assert.strictEqual(result.concurrency, undefined);
            }
            finally {
                teardown();
            }
        });
    });
});
