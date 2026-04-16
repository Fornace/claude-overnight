#!/usr/bin/env node
// Tiny launcher: prints a splash the instant node is ready, then dynamically
// imports the real entrypoint. Loading `@anthropic-ai/claude-agent-sdk` and the
// rest of the module graph takes several seconds on a cold cache  -- without
// this, the terminal sits black that whole time. index.ts stops the splash
// via `globalThis.__coStopSplash` as soon as its header is about to print.

// Cursor agent: never inherit a shell that disabled keychain skip (`CI=0`,
// empty `CURSOR_SKIP_KEYCHAIN`) — the Cursor CLI may prompt for "cursor-user"
// and block preflight. Force like cursor-composer-in-claude/dist/cli.js (not ??=).
// NOTE: CI=true is only set in child process envs (proxy spawn, agent spawn) —
// setting it here kills chalk color detection (supports-color returns level 0).
process.env.CURSOR_SKIP_KEYCHAIN = "1";

const argv = process.argv.slice(2);
const quiet = argv.includes("-h") || argv.includes("--help") || argv.includes("-v") || argv.includes("--version");

// Auto-update: check npm at most once every 4 hours, install and re-exec if newer.
// Skipped in non-TTY (CI/pipe) mode, on --help/--version, and if CLAUDE_OVERNIGHT_UPDATED is set.
if (process.stdout.isTTY && !quiet && !process.env.CLAUDE_OVERNIGHT_UPDATED) {
  const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const tsFile = join(homedir(), ".claude-overnight-update-ts");
  let shouldCheck = true;
  try { shouldCheck = Date.now() - parseInt(readFileSync(tsFile, "utf-8").trim(), 10) > UPDATE_INTERVAL_MS; } catch {}
  if (shouldCheck) {
    try {
      writeFileSync(tsFile, String(Date.now())); // stamp first so failures don't re-trigger
      const { execFileSync, spawnSync } = await import("node:child_process");
      const latest = execFileSync("npm", ["show", "claude-overnight", "version"], { encoding: "utf-8", timeout: 6000 }).trim();
      const { VERSION } = await import("./_version.js");
      if (latest !== VERSION) {
        process.stdout.write(`\r\x1b[2K  🌙  claude-overnight \x1b[33m${VERSION} → ${latest}\x1b[0m  updating…\n`);
        execFileSync("npm", ["i", "-g", `claude-overnight@${latest}`], { stdio: "inherit", timeout: 60000 });
        const r = spawnSync(process.argv[0], process.argv.slice(1), {
          stdio: "inherit", env: { ...process.env, CLAUDE_OVERNIGHT_UPDATED: "1" },
        });
        process.exit(r.status ?? 0);
      }
    } catch {} // silent — never block startup for a failed update check
  }
}

if (!quiet && process.stdout.isTTY) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const render = () => process.stdout.write(
    `\r\x1b[2K  🌙  \x1b[1mclaude-overnight\x1b[0m  \x1b[2m${frames[i++ % frames.length]} starting…\x1b[0m`,
  );
  render();
  const timer = setInterval(render, 120);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K");
  };
  (globalThis as any).__coStopSplash = stop;
  process.once("exit", stop);
}

await import("./index.js");
