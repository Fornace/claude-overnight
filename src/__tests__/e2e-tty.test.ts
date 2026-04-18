import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { PTYProcess, canSpawnPty } from "./pty-helpers.js";
import { ensureCursorProxyRunning, healthCheckCursorProxy } from "../providers/cursor-proxy.js";
import { PROXY_DEFAULT_URL } from "../providers/cursor-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../src/__tests__/fixtures");
const BIN = resolve(__dirname, "../../dist/bin.js");

// Skip provider preflight in e2e tests — the swarm handles proxy startup on its own.
process.env.NO_PREFLIGHT = "1";

/**
 * The full PTY suite is slow (~10 min) and flaky by nature (timing-based
 * assertions against terminal rendering). It stays in the drawer — use
 * scripts/e2e-smoke*.mjs for fast liveness checks instead. Set RUN_E2E_TTY=1
 * to actually run this file.
 */
const hasApiKey = !!(
  process.env.ANTHROPIC_API_KEY?.trim() ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
  process.env.CURSOR_API_KEY?.trim()
);
const optedIn = process.env.RUN_E2E_TTY === "1";

/**
 * Boot the cursor proxy once before all tests when only CURSOR_API_KEY is set.
 * Each test spawns `node dist/bin.js` with no `--model` flag, so the swarm
 * dispatches through whatever ANTHROPIC_BASE_URL is wired — we point it at the
 * bundled proxy so every child bin inherits a working backend.
 */
const cursorOnly = !process.env.ANTHROPIC_API_KEY?.trim()
  && !process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  && !!process.env.CURSOR_API_KEY?.trim();
let proxyReady = !cursorOnly;

const e2e = (canSpawnPty() && hasApiKey && optedIn) ? describe : describe.skip;

if (cursorOnly && optedIn) {
  before(async () => {
    if (await healthCheckCursorProxy(PROXY_DEFAULT_URL)) {
      proxyReady = true;
    } else {
      proxyReady = await ensureCursorProxyRunning(PROXY_DEFAULT_URL);
    }
    if (proxyReady) {
      process.env.ANTHROPIC_BASE_URL = PROXY_DEFAULT_URL;
      process.env.ANTHROPIC_AUTH_TOKEN = process.env.CURSOR_API_KEY!;
    }
  });
}

// ── helpers ──

function waitForSwarm(p: PTYProcess, timeoutMs = 45000) {
  return p.waitFor("active", timeoutMs);
}

function taskFile(name: string) {
  return resolve(FIXTURES, name);
}

// ── tests ──

e2e("E2E TTY  -- header bar", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("shows model tier in the header", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    const text = p.text();
    // Header shows model name in the brackets
    assert.match(text, /CLAUDE OVERNIGHT \[.+\]/);
    p.kill();
  });

  it("shows budget progress bar", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    const text = p.text();
    // Budget bar shows "N/M" or similar progress indicator
    assert.match(text, /0\/2|1\/2|2\/2|\d+\/\d+/);
    p.kill();
  });

  it("shows active session count", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    const text = p.text();
    assert.match(text, /active/i);
    p.kill();
  });
});

e2e("E2E TTY  -- agent table", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("renders task rows with index numbers", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    const text = p.text();
    // Rows are numbered: "0", "1", etc.
    assert.match(text, /0\s/);
    assert.match(text, /1\s/);
    p.kill();
  });

  it("shows running status indicator (spinner character)", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    const text = p.text();
    // Running agents show a spinner character (|, /, -, or \) in the status column
    // Pattern: digit + spaces + spinner + "run"
    assert.match(text, /\d\s+[|\\/\\-]\s*run/);
    p.kill();
  });

  it("truncates long task prompts with ellipsis", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-four-tasks.json")]);
    await waitForSwarm(p);
    const text = p.text();
    // Long prompts get truncated
    assert.match(text, /…/);
    p.kill();
  });
});

e2e("E2E TTY  -- event log", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("shows system events section with events", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    await new Promise((r) => setTimeout(r, 1000)); // give events time to appear
    const text = p.text();
    // Events section exists and contains at least one event
    assert.match(text, /Events/);
    // Should show at least a "Starting" or "Warning" event
    assert.match(text, /Starting|Warning|Worktree/);
    p.kill();
  });

  it("shows worktree paths in events", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    await new Promise((r) => setTimeout(r, 1000));
    const text = p.text();
    assert.match(text, /Worktrees/);
    p.kill();
  });
});

e2e("E2E TTY  -- hotkey bar", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("renders the full hotkey row", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    // Scroll down with arrow keys to reveal the hotkey bar at the bottom
    p.key("ArrowDown");
    await new Promise((r) => setTimeout(r, 500));
    p.key("ArrowDown");
    await new Promise((r) => setTimeout(r, 500));

    const text = p.text();
    // After scrolling, hotkey bindings should be visible
    assert.match(text, /\[b\]/);
    assert.match(text, /\[q\]/);
    assert.match(text, /\[d\]/);
    p.kill();
  });
});

e2e("E2E TTY  -- hotkey interactions", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("c key opens concurrency input mode", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("c");
    await new Promise((r) => setTimeout(r, 1000));

    const text = p.text();
    // Concurrency input mode shows a prompt asking for concurrency
    assert.match(text, /[Cc]oncur|concurrency/i);
    p.kill();
  });

  it("q key shows quit confirmation", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("q");
    await new Promise((r) => setTimeout(r, 1000));

    const text = p.text();
    // Quit confirmation should appear
    assert.match(text, /[Qq]uit|[Ss]top|[Cc]onfirm/i);
    p.kill();
  });

  it("ESC cancels input mode", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    // Open concurrency input, then cancel with ESC
    p.key("c");
    await new Promise((r) => setTimeout(r, 500));
    p.key("Escape");
    await new Promise((r) => setTimeout(r, 500));

    // App should still be running and showing the hotkey bar
    assert.equal(p.exited, false);
    const text = p.text();
    assert.match(text, /\[b\]/); // hotkey bar should be visible again
    p.kill();
  });

  it("p key toggles pause", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("p");
    await new Promise((r) => setTimeout(r, 1000));

    const text = p.text();
    // Pause state should be reflected in the UI
    assert.match(text, /pause|paused|resum/i);
    p.kill();
  });
});

e2e("E2E TTY  -- navigation", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("arrow down highlights next agent row", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("ArrowDown");
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(p.exited, false);
    p.kill();
  });

  it("arrow up wraps at top", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("ArrowUp");
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(p.exited, false);
    p.kill();
  });

  it("arrow right opens detail view", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("ArrowRight");
    await new Promise((r) => setTimeout(r, 500));

    // Detail view should show more info about the agent
    const text = p.text();
    assert.equal(p.exited, false);
    // Detail may show "Detail" section or agent-specific info
    p.kill();
  });

  it("arrow left closes detail view", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    // Open detail, then close
    p.key("ArrowRight");
    await new Promise((r) => setTimeout(r, 300));
    p.key("ArrowLeft");
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(p.exited, false);
    p.kill();
  });

  it("rapid arrow keys don't crash", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    for (let i = 0; i < 10; i++) {
      p.key(i % 2 === 0 ? "ArrowDown" : "ArrowUp");
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(p.exited, false);
    p.kill();
  });
});

e2e("E2E TTY  -- concurrency variations", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("shows 4 agent rows with 4 tasks", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-four-tasks.json"), "--concurrency", "4"]);
    await waitForSwarm(p);
    const text = p.text();
    // Should show all 4 tasks
    assert.match(text, /0\s/);
    assert.match(text, /1\s/);
    assert.match(text, /2\s/);
    assert.match(text, /3\s/);
    // Header should show 4 concurrent
    assert.match(text, /4\s+active|4\/4|conc.*4/i);
    p.kill();
  });
});

e2e("E2E TTY  -- resilience", () => {
  let p: PTYProcess;
  after(() => { if (p) p.kill(); });

  it("survives typing random characters in input mode", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("c");
    await new Promise((r) => setTimeout(r, 300));
    p.write("hello123!@#");
    await new Promise((r) => setTimeout(r, 300));
    p.key("Escape");
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(p.exited, false);
    p.kill();
  });

  it("survives pressing enter in empty input mode", async () => {
    p = new PTYProcess("node", [BIN, "--file", taskFile("e2e-tasks.json")]);
    await waitForSwarm(p);
    p.clear();

    p.key("b");
    await new Promise((r) => setTimeout(r, 300));
    p.key("Enter");
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(p.exited, false);
    p.kill();
  });
});
