#!/usr/bin/env node
// Tiny launcher: prints a splash the instant node is ready, then dynamically
// imports the real entrypoint. Loading `@anthropic-ai/claude-agent-sdk` and the
// rest of the module graph takes several seconds on a cold cache  -- without
// this, the terminal sits black that whole time. index.ts stops the splash
// via `globalThis.__coStopSplash` as soon as its header is about to print.
const argv = process.argv.slice(2);
const quiet = argv.includes("-h") || argv.includes("--help") || argv.includes("-v") || argv.includes("--version");
if (!quiet && process.stdout.isTTY) {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const render = () => process.stdout.write(`\r\x1b[2K  🌙  \x1b[1mclaude-overnight\x1b[0m  \x1b[2m${frames[i++ % frames.length]} starting…\x1b[0m`);
    render();
    const timer = setInterval(render, 120);
    let stopped = false;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearInterval(timer);
        process.stdout.write("\r\x1b[2K");
    };
    globalThis.__coStopSplash = stop;
    process.once("exit", stop);
}
await import("./index.js");
export {};
