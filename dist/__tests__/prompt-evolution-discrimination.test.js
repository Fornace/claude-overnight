/**
 * Discrimination test — the sanity gate for the benchmark.
 *
 * The premise: if the benchmark cannot reliably rank a deliberately-broken
 * prompt below a working one, then evolution is chasing noise and every
 * score in the report is theatrical.
 *
 * We wire a mock `callModel` into buildMatrix so the test is deterministic
 * and requires no network. Two variants compete:
 *
 *   good:   returns well-formed JSON with tasks matching the case budget,
 *           independent and file-specific.
 *   broken: returns either invalid JSON or wildly-off-budget output.
 *
 * If good doesn't beat broken by a comfortable margin, something regressed
 * in scorer/evaluator and the whole evolution pipeline is unreliable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMatrix } from "../prompt-evolution/evaluator.js";
function makeCase(name, budget) {
    const c = {
        name,
        hash: "",
        promptPath: "test/plan",
        variant: "STANDARD",
        vars: { objective: `test objective ${name}`, budget, concurrency: 2 },
        criteria: {
            independentTasks: true,
            specificTasks: true,
            requiredJsonFields: ["tasks"],
        },
    };
    c.hash = `h_${name}`;
    return c;
}
function goodOutput(budget) {
    const tasks = Array.from({ length: budget }, (_, i) => ({
        prompt: `Update src/module_${i}.ts to adjust the handler function in the route.`,
    }));
    return JSON.stringify({ tasks });
}
/**
 * Canned generator: looks at the prompt text for a sentinel string and
 * returns one of our canned outputs. Lets a single mock drive many variants.
 */
function mockCallModelFor(variantBehavior) {
    return async (userText) => {
        const which = [...variantBehavior.keys()].find((k) => userText.includes(k)) ?? "default";
        const budgetMatch = userText.match(/budget=(\d+)/);
        const budget = budgetMatch ? parseInt(budgetMatch[1], 10) : 5;
        const raw = (variantBehavior.get(which) ?? (() => goodOutput(budget)))(budget);
        // Pretend the call used ~1k tokens
        return {
            raw,
            costUsd: 0.001,
            inputTokens: 500,
            outputTokens: 500,
        };
    };
}
describe("discrimination (sanity gate)", () => {
    const cases = [
        makeCase("short-fix", 5),
        makeCase("medium-feature", 10),
        makeCase("large-refactor", 25),
    ];
    const variants = [
        { id: "good", promptPath: "test/plan", generation: 0, text: "SENTINEL_GOOD budget=5" },
        { id: "broken", promptPath: "test/plan", generation: 0, text: "SENTINEL_BROKEN budget=5" },
    ];
    it("ranks good above broken when broken returns invalid JSON", async () => {
        const behavior = new Map([
            ["SENTINEL_GOOD", (b) => goodOutput(b)],
            ["SENTINEL_BROKEN", () => "I'm sorry, I cannot return JSON today."],
        ]);
        const rows = await buildMatrix(variants, cases, {
            model: "mock",
            callModel: mockCallModelFor(behavior),
        });
        const good = rows.find((r) => r.variantId === "good");
        const broken = rows.find((r) => r.variantId === "broken");
        assert.ok(good.gmean > broken.gmean + 0.2, `good (${good.gmean.toFixed(3)}) must beat broken (${broken.gmean.toFixed(3)}) by ≥0.2`);
        assert.equal(broken.parseFailures, cases.length, "every broken case should count as a parse failure");
        assert.equal(good.parseFailures, 0);
    });
    it("ranks good above broken when broken is wildly off-budget", async () => {
        const behavior = new Map([
            ["SENTINEL_GOOD", (b) => goodOutput(b)],
            ["SENTINEL_BROKEN", (b) => {
                    // 10× budget — triggers the budget-sanity content penalty.
                    const tasks = Array.from({ length: b * 10 }, () => ({ prompt: "do a thing after the other one" }));
                    return JSON.stringify({ tasks });
                }],
        ]);
        const rows = await buildMatrix(variants, cases, {
            model: "mock",
            callModel: mockCallModelFor(behavior),
        });
        const good = rows.find((r) => r.variantId === "good");
        const broken = rows.find((r) => r.variantId === "broken");
        assert.ok(good.aggregate.content > broken.aggregate.content + 0.3, `good content (${good.aggregate.content.toFixed(3)}) must beat broken content (${broken.aggregate.content.toFixed(3)}) by ≥0.3`);
    });
    it("reports cross-model stddev when multiple models are used", async () => {
        // Simulate one strong model, one weak model.
        const callModel = async (userText, _sys, opts) => {
            const budgetMatch = userText.match(/budget=(\d+)/);
            const budget = budgetMatch ? parseInt(budgetMatch[1], 10) : 5;
            if (opts.model === "weak-model") {
                return { raw: "not json", costUsd: 0.001, inputTokens: 500, outputTokens: 500 };
            }
            return { raw: goodOutput(budget), costUsd: 0.001, inputTokens: 500, outputTokens: 500 };
        };
        const rows = await buildMatrix([{ id: "default", promptPath: "test/plan", generation: 0, text: "SENTINEL budget=5" }], cases, { model: "strong-model", models: ["strong-model", "weak-model"], callModel });
        const row = rows[0];
        assert.ok(row.crossModelStddev != null && row.crossModelStddev > 0.1, `expected cross-model stddev > 0.1 when one model fails, got ${row.crossModelStddev}`);
        assert.ok(row.perModel && row.perModel["strong-model"].parse === 1);
        assert.ok(row.perModel && row.perModel["weak-model"].parse === 0);
    });
    it("aggregates repetitions into a single result with a stddev", async () => {
        let callCount = 0;
        // Alternate between good and bad output to force nonzero stddev.
        const callModel = async (userText) => {
            callCount++;
            const budgetMatch = userText.match(/budget=(\d+)/);
            const budget = budgetMatch ? parseInt(budgetMatch[1], 10) : 5;
            const raw = callCount % 2 === 0 ? goodOutput(budget) : "not json";
            return { raw, costUsd: 0.001, inputTokens: 500, outputTokens: 500 };
        };
        const rows = await buildMatrix([{ id: "flaky", promptPath: "test/plan", generation: 0, text: "SENTINEL budget=5" }], [makeCase("c1", 5)], { model: "mock", repetitions: 4, callModel });
        const [result] = [...rows[0].results.values()];
        assert.equal(result.reps, 4);
        assert.ok(result.stddev != null);
        assert.ok(result.stddev.parse > 0, "parse dimension should have nonzero stddev across flaky reps");
    });
});
