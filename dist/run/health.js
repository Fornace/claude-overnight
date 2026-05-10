import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { readJsonOrNull } from "../core/fs-helpers.js";
import { renderPrompt } from "../prompts/load.js";
/** Detect build errors and return one or more heal tasks. If errors span ≥2 files,
 *  emit one task per file so they heal in parallel without merge conflicts. */
export function checkProjectHealth(cwd) {
    const cmd = detectHealthCommand(cwd);
    if (!cmd)
        return [];
    try {
        execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
        return [];
    }
    catch (err) {
        if (err.killed)
            return [];
        const output = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
        const trimmed = output.length > 4000 ? output.slice(0, 2000) + "\n…\n" + output.slice(-2000) : output;
        // B4: Split heal by file — extract distinct source file paths from errors
        const fileRe = /\/src\/[\w./-]+\.(ts|tsx|js|jsx)/g;
        const files = new Set();
        for (const m of trimmed.matchAll(fileRe))
            files.add(m[0]);
        if (files.size >= 2) {
            // One task per file — each agent gets only that file's error context
            const fileErrors = new Map();
            for (const f of files) {
                // Extract lines mentioning this file
                const lines = trimmed.split("\n").filter(l => l.includes(f));
                fileErrors.set(f, lines.slice(0, 30).join("\n"));
            }
            return Array.from(fileErrors.entries()).map(([file, errs], i) => ({
                id: `heal-${i}`,
                prompt: renderPrompt("60_runtime/60-4_build-fix", { variant: "FILE", vars: { file, cmd, errors: errs } }),
                type: "heal",
            }));
        }
        return [{
                id: "heal-0",
                prompt: renderPrompt("60_runtime/60-4_build-fix", { variant: "ALL", vars: { cmd, errors: trimmed } }),
                type: "heal",
            }];
    }
}
export function detectHealthCommand(cwd) {
    const has = (p) => existsSync(join(cwd, p));
    const pkg = readJsonOrNull(join(cwd, "package.json"));
    const scripts = pkg?.scripts ?? {};
    for (const name of ["typecheck", "check:types", "type-check", "build"]) {
        if (scripts[name]) {
            const pm = has("pnpm-lock.yaml") ? "pnpm"
                : has("bun.lockb") || has("bun.lock") ? "bun"
                    : has("yarn.lock") ? "yarn" : "npm";
            return `${pm} run ${name}`;
        }
    }
    if (has("tsconfig.json"))
        return "npx -y tsc --noEmit";
    if (has("Cargo.toml"))
        return "cargo check --quiet";
    if (has("go.mod"))
        return "go build ./...";
    if (has("deno.json") || has("deno.jsonc"))
        return "deno check .";
    if (has("mix.exs"))
        return "mix compile --warnings-as-errors";
    return undefined;
}
