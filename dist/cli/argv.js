// Argv parsing + bootstrap-time validation. Pure: no stdio, no SDK.
import { execSync } from "child_process";
const KNOWN_VALUE_FLAGS = new Set(["concurrency", "model", "timeout", "budget", "usage-cap", "extra-usage-budget", "merge"]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "-h", "--help", "-v", "--version", "--flex", "--no-flex", "--allow-extra-usage", "--worktrees", "--no-worktrees", "--yolo"]);
export function parseCliFlags(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (BOOLEAN_FLAGS.has(arg))
            continue;
        const eq = arg.match(/^--(\w[\w-]*)=(.+)$/);
        if (eq && KNOWN_VALUE_FLAGS.has(eq[1])) {
            flags[eq[1]] = eq[2];
            continue;
        }
        const bare = arg.match(/^--(\w[\w-]*)$/);
        if (bare && KNOWN_VALUE_FLAGS.has(bare[1]) && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
            flags[bare[1]] = argv[++i];
            continue;
        }
        if (!arg.startsWith("--"))
            positional.push(arg);
    }
    return { flags, positional };
}
export function validateConcurrency(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`Concurrency must be a positive integer (got ${JSON.stringify(value)})`);
    }
}
export function isGitRepo(cwd) {
    try {
        execSync("git rev-parse --git-dir", { cwd, encoding: "utf-8", stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
}
export function validateGitRepo(cwd) {
    if (!isGitRepo(cwd)) {
        throw new Error(`Worktrees require a git repository, but ${cwd} is not inside one.\n` +
            `  Run: cd ${cwd} && git init\n` +
            `  Or set "worktrees": false in your task file.`);
    }
}
