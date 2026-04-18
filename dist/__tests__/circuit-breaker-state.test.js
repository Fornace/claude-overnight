import test from "node:test";
import assert from "node:assert/strict";
import { updateCircuitBreakerStreak } from "../run/circuit-breaker-state.js";
test("circuit breaker: tools>0 and filesChanged=0 does not advance halt streak", () => {
    const r = updateCircuitBreakerStreak({
        waveNum: 2,
        prevStreak: 1,
        nonHealFiles: 0,
        totalToolCallsAllAgents: 7,
    });
    assert.equal(r.streak, 0);
    assert.equal(r.shouldHalt, false);
});
test("circuit breaker: tools=0 and filesChanged=0 advances streak toward halt", () => {
    const wave1 = updateCircuitBreakerStreak({
        waveNum: 1,
        prevStreak: 0,
        nonHealFiles: 0,
        totalToolCallsAllAgents: 0,
    });
    assert.equal(wave1.streak, 1);
    assert.equal(wave1.shouldHalt, false);
    const wave2 = updateCircuitBreakerStreak({
        waveNum: 2,
        prevStreak: wave1.streak,
        nonHealFiles: 0,
        totalToolCallsAllAgents: 0,
    });
    assert.equal(wave2.streak, 2);
    assert.equal(wave2.shouldHalt, true);
});
test("circuit breaker: non-heal files landed resets streak", () => {
    const r = updateCircuitBreakerStreak({
        waveNum: 3,
        prevStreak: 1,
        nonHealFiles: 2,
        totalToolCallsAllAgents: 0,
    });
    assert.equal(r.streak, 0);
    assert.equal(r.shouldHalt, false);
});
test("circuit breaker: wave 0 never advances streak", () => {
    const r = updateCircuitBreakerStreak({
        waveNum: 0,
        prevStreak: 99,
        nonHealFiles: 0,
        totalToolCallsAllAgents: 0,
    });
    assert.equal(r.streak, 0);
    assert.equal(r.shouldHalt, false);
});
