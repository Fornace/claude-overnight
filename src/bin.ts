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
