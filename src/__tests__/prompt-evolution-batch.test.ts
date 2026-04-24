/**
 * Batch-transport discrimination test.
 *
 * Same sanity-gate premise as the online discrimination test: if the batch
 * path can't rank a deliberately-broken prompt below a working one, it's
 * shipping theatrical scores. Uses an injected `batchCallModel` mock so the
 * test is hermetic and runs without network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMatrix } from "../prompt-evolution/evaluator.js";
import type { BenchmarkCase } from "../prompt-evolution/types.js";
import type { CallModelResult } from "../prompt-evolution/transport.js";
import type { BatchJob } from "../prompt-evolution/transport-batch.js";

function makeCase(name: string, budget: number): BenchmarkCase {
  const c: BenchmarkCase = {
    name,
    hash: `h_${name}`,
    promptPath: "test/plan",
    variant: "STANDARD",
    vars: { objective: `objective ${name}`, budget, concurrency: 2 },
    criteria: { independentTasks: true, specificTasks: true, requiredJsonFields: ["tasks"] },
  };
  return c;
}

function goodOutput(budget: number): string {
  const tasks = Array.from({ length: budget }, (_, i) => ({
    prompt: `Update src/module_${i}.ts handler function in route`,
  }));
  return JSON.stringify({ tasks });
}

describe("batch discrimination (sanity gate)", () => {
  const cases: BenchmarkCase[] = [
    makeCase("short-fix", 5),
    makeCase("medium", 10),
    makeCase("large", 25),
  ];

  const variants = [
    { id: "good",   promptPath: "test/plan", generation: 0, text: "SENTINEL_GOOD budget=5" },
    { id: "broken", promptPath: "test/plan", generation: 0, text: "SENTINEL_BROKEN budget=5" },
  ];

  it("routes batch results back to the right cell via custom_id", async () => {
    // Mock batch transport returns a different output depending on which
    // variant the job came from — detected by sentinel string in userText.
    const mockBatch = async (jobs: BatchJob[]): Promise<Map<string, CallModelResult>> => {
      const out = new Map<string, CallModelResult>();
      for (const j of jobs) {
        const budgetMatch = j.userText.match(/budget=(\d+)/);
        const budget = budgetMatch ? parseInt(budgetMatch[1], 10) : 5;
        const raw = j.userText.includes("SENTINEL_BROKEN") ? "sorry, no JSON" : goodOutput(budget);
        out.set(j.customId, { raw, costUsd: 0.0005, inputTokens: 500, outputTokens: 500 });
      }
      return out;
    };

    const rows = await buildMatrix(variants, cases, {
      model: "mock",
      batch: true,
      batchCallModel: mockBatch,
    });

    const good = rows.find((r) => r.variantId === "good")!;
    const broken = rows.find((r) => r.variantId === "broken")!;

    assert.ok(good.gmean > broken.gmean + 0.2,
      `good (${good.gmean.toFixed(3)}) must beat broken (${broken.gmean.toFixed(3)}) by ≥0.2`);
    assert.equal(broken.parseFailures, cases.length, "every broken cell should count as parse failure");
    assert.equal(good.parseFailures, 0);
  });

  it("batch cost reports half the online cost (approximate)", async () => {
    // The batch transport itself halves costUsd per the provider discount;
    // here we send synthetic costs and check the batch path propagates them.
    const mockBatch = async (jobs: BatchJob[]): Promise<Map<string, CallModelResult>> => {
      const out = new Map<string, CallModelResult>();
      for (const j of jobs) {
        out.set(j.customId, { raw: goodOutput(5), costUsd: 0.001, inputTokens: 500, outputTokens: 500 });
      }
      return out;
    };
    const rows = await buildMatrix(
      [{ id: "default", promptPath: "test/plan", generation: 0, text: "SENTINEL budget=5" }],
      [makeCase("c1", 5)],
      { model: "mock", batch: true, batchCallModel: mockBatch },
    );
    const [result] = [...rows[0].results.values()];
    assert.equal(result.costUsd, 0.001, "batch cost must flow through to the scored result");
  });

  it("handles reps correctly under batch (every rep submitted with unique custom_id)", async () => {
    const customIdsSeen = new Set<string>();
    const mockBatch = async (jobs: BatchJob[]): Promise<Map<string, CallModelResult>> => {
      for (const j of jobs) customIdsSeen.add(j.customId);
      const out = new Map<string, CallModelResult>();
      for (const j of jobs) {
        out.set(j.customId, { raw: goodOutput(5), costUsd: 0.0005, inputTokens: 500, outputTokens: 500 });
      }
      return out;
    };
    const rows = await buildMatrix(
      [{ id: "default", promptPath: "test/plan", generation: 0, text: "SENTINEL budget=5" }],
      [makeCase("c1", 5)],
      { model: "mock", batch: true, repetitions: 4, batchCallModel: mockBatch },
    );
    assert.equal(customIdsSeen.size, 4, "all 4 reps must have been submitted with unique custom_ids");
    const [result] = [...rows[0].results.values()];
    assert.equal(result.reps, 4);
  });
});
