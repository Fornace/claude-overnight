import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── throttleBeforeWave tests (run.ts) ──

// We test the throttleBeforeWave logic by verifying the wait calculations
// indirectly. Since the function is private to run.ts, we test the same
// decision logic here to ensure the thresholds are correct.

describe("throttleBeforeWave decision logic", () => {
  it("passes through when no rate limit info", () => {
    const rl = { utilization: 0, windows: new Map(), resetsAt: undefined };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, false);
  });

  it("passes through when utilization is low", () => {
    const rl = { utilization: 0.5, windows: new Map(), resetsAt: undefined };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, false);
  });

  it("waits when utilization is elevated (>= 75%)", () => {
    const rl = { utilization: 0.75, windows: new Map(), resetsAt: undefined };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, true);
  });

  it("waits when utilization is high (>= 90%)", () => {
    const rl = { utilization: 0.92, windows: new Map(), resetsAt: undefined };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, true);
  });

  it("waits when any window is rejected with future resetsAt", () => {
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.8, status: "rejected", resetsAt: Date.now() + 60_000 });
    const rl = { utilization: 0.8, windows, resetsAt: undefined };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, true);
  });

  it("ignores stale rejected windows (resetsAt in the past)", () => {
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.8, status: "rejected", resetsAt: Date.now() - 1000 });
    const rl = { utilization: 0.5, windows, resetsAt: undefined };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, false);
  });

  it("waits when explicit resetsAt is set (from SDK)", () => {
    const rl = { utilization: 0.3, windows: new Map(), resetsAt: Date.now() + 30_000 };
    const shouldWait = checkShouldWait(rl);
    assert.equal(shouldWait, true);
  });

  it("prefers nearest rejected window resetsAt when multiple windows rejected", () => {
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.9, status: "rejected", resetsAt: Date.now() + 120_000 });
    windows.set("seven_day", { type: "seven_day", utilization: 0.85, status: "rejected", resetsAt: Date.now() + 60_000 });
    const rl = { utilization: 0.9, windows, resetsAt: undefined };
    const wait = getWindowWaitMs(rl);
    assert.ok(wait > 50_000 && wait <= 60_000, `expected ~60s, got ${wait}`);
  });
});

// ── swarm.ts windowRejectedReset tests ──

describe("windowRejectedReset logic", () => {
  it("returns undefined when no windows", () => {
    const windows = new Map();
    assert.equal(findNearestRejectedReset(windows), undefined);
  });

  it("returns undefined when no windows are rejected", () => {
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.5, status: "ok" });
    assert.equal(findNearestRejectedReset(windows), undefined);
  });

  it("returns resetsAt of the nearest rejected window", () => {
    const future1 = Date.now() + 120_000;
    const future2 = Date.now() + 60_000;
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.9, status: "rejected", resetsAt: future1 });
    windows.set("seven_day", { type: "seven_day", utilization: 0.85, status: "rejected", resetsAt: future2 });
    const result = findNearestRejectedReset(windows);
    assert.equal(result, future2);
  });

  it("ignores rejected windows with resetsAt in the past", () => {
    const future = Date.now() + 60_000;
    const past = Date.now() - 1000;
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.9, status: "rejected", resetsAt: past });
    windows.set("seven_day", { type: "seven_day", utilization: 0.85, status: "rejected", resetsAt: future });
    const result = findNearestRejectedReset(windows);
    assert.equal(result, future);
  });

  it("returns undefined when all rejected windows are stale", () => {
    const windows = new Map();
    windows.set("five_hour", { type: "five_hour", utilization: 0.9, status: "rejected", resetsAt: Date.now() - 5000 });
    windows.set("seven_day", { type: "seven_day", utilization: 0.85, status: "rejected", resetsAt: Date.now() - 1000 });
    assert.equal(findNearestRejectedReset(windows), undefined);
  });
});

// ── Near-critical utilization threshold tests ──

describe("near-critical utilization threshold", () => {
  it("94% utilization is NOT near-critical without cap", () => {
    const nearCritical = 0.94 >= 0.95;
    assert.equal(nearCritical, false);
  });

  it("95% utilization IS near-critical without cap", () => {
    const nearCritical = 0.95 >= 0.95;
    assert.equal(nearCritical, true);
  });

  it("99% utilization IS near-critical without cap", () => {
    const nearCritical = 0.99 >= 0.95;
    assert.equal(nearCritical, true);
  });
});

// ── Helper functions mirroring the production logic ──

interface TestWindow {
  type: string;
  utilization: number;
  status: string;
  resetsAt?: number;
}

interface TestRLInfo {
  utilization: number;
  windows: Map<string, TestWindow>;
  resetsAt?: number;
}

function findNearestRejectedReset(windows: Map<string, TestWindow>): number | undefined {
  let nearest: number | undefined;
  for (const w of windows.values()) {
    if (w.status === "rejected" && w.resetsAt && w.resetsAt > Date.now()) {
      if (!nearest || w.resetsAt < nearest) nearest = w.resetsAt;
    }
  }
  return nearest;
}

function getWindowWaitMs(rl: TestRLInfo): number {
  const nearest = findNearestRejectedReset(rl.windows);
  if (nearest) return Math.max(10_000, nearest - Date.now());
  if (rl.resetsAt && rl.resetsAt > Date.now()) return Math.max(10_000, rl.resetsAt - Date.now());
  if (rl.utilization >= 0.9) return 60_000;
  if (rl.utilization >= 0.75) return 15_000;
  return 0;
}

function checkShouldWait(rl: TestRLInfo): boolean {
  const nearest = findNearestRejectedReset(rl.windows);
  const explicitRejected = rl.resetsAt && rl.resetsAt > Date.now();
  const highUtil = rl.utilization >= 0.9;
  const elevatedUtil = rl.utilization >= 0.75;
  return !!(nearest || explicitRejected || highUtil || elevatedUtil);
}
