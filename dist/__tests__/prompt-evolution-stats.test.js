/**
 * Statistical-primitive tests: paired permutation test + deterministic
 * train/test split. These two together are the rigor guarantees the
 * benchmark pipeline depends on, so they get their own gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pairedPermutationTest, kendallTau, bootstrapCI } from "../prompt-evolution/scorer.js";
describe("pairedPermutationTest", () => {
    it("returns p ≈ 1 for all-zero differences", () => {
        const { pValue, observed } = pairedPermutationTest([0, 0, 0, 0, 0], 2000);
        assert.equal(observed, 0);
        assert.ok(pValue >= 0.9, `p should be near 1 for null, got ${pValue}`);
    });
    it("returns very small p for a clearly non-null difference", () => {
        // Ten paired diffs all strongly positive → any sign flip produces a
        // smaller mean, so observed sits at the far tail of the null distro.
        const diffs = [0.3, 0.25, 0.35, 0.28, 0.31, 0.27, 0.33, 0.29, 0.26, 0.32];
        const { pValue, observed } = pairedPermutationTest(diffs, 5000);
        assert.ok(observed > 0.25);
        assert.ok(pValue < 0.005, `p should be <0.005 for uniformly strong positive effect, got ${pValue}`);
    });
    it("handles mixed signs correctly", () => {
        // Five positive, five negative — null hypothesis plausible.
        const diffs = [0.2, -0.18, 0.21, -0.19, 0.22, -0.17, 0.2, -0.2, 0.19, -0.21];
        const { pValue } = pairedPermutationTest(diffs, 5000);
        assert.ok(pValue > 0.2, `p should be >0.2 for symmetric diffs, got ${pValue}`);
    });
    it("returns p=1 for empty input (no data, no claim)", () => {
        const { pValue } = pairedPermutationTest([], 1000);
        assert.equal(pValue, 1);
    });
});
describe("kendallTau", () => {
    it("returns 1 for identical rankings", () => {
        assert.equal(kendallTau(["a", "b", "c", "d"], ["a", "b", "c", "d"]), 1);
    });
    it("returns -1 for reversed rankings", () => {
        assert.equal(kendallTau(["a", "b", "c", "d"], ["d", "c", "b", "a"]), -1);
    });
    it("handles partial agreement (1 swap out of 4) → 4/6 concordant", () => {
        // Ranks: a,b,c,d vs a,c,b,d — swap positions 2 and 3
        // Pairs (a,b):++, (a,c):++, (a,d):++, (b,c):-+ discordant, (b,d):++, (c,d):++
        // 5 concordant, 1 discordant → τ = 4/6 ≈ 0.67
        const tau = kendallTau(["a", "b", "c", "d"], ["a", "c", "b", "d"]);
        assert.ok(Math.abs(tau - 4 / 6) < 0.01, `expected ~0.67, got ${tau}`);
    });
});
describe("bootstrapCI", () => {
    it("CI brackets the mean of a tight distribution", () => {
        const vals = [0.5, 0.51, 0.49, 0.5, 0.5, 0.51, 0.49, 0.5];
        const [lo, hi] = bootstrapCI(vals, 2000);
        assert.ok(lo <= 0.5 && hi >= 0.5, `CI must bracket true mean 0.5, got [${lo}, ${hi}]`);
        assert.ok(hi - lo < 0.1, `tight sample should yield narrow CI, got width ${hi - lo}`);
    });
    it("wide distribution yields wide CI", () => {
        const vals = [0, 1, 0, 1, 0, 1, 0, 1];
        const [lo, hi] = bootstrapCI(vals, 2000);
        assert.ok(hi - lo > 0.3, `wide distribution should yield wide CI, got width ${hi - lo}`);
    });
    it("single value yields point CI", () => {
        const [lo, hi] = bootstrapCI([0.7], 100);
        assert.equal(lo, 0.7);
        assert.equal(hi, 0.7);
    });
});
