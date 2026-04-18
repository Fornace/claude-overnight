import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { Task } from "../core/types.js";

/** Detect build errors and return one or more heal tasks. If errors span ≥2 files,
 *  emit one task per file so they heal in parallel without merge conflicts. */
export function checkProjectHealth(cwd: string): Task[] {
  const cmd = detectHealthCommand(cwd);
  if (!cmd) return [];
  try {
    execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
    return [];
  } catch (err: any) {
    if (err.killed) return [];
    const output = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
    const trimmed = output.length > 4000 ? output.slice(0, 2000) + "\n…\n" + output.slice(-2000) : output;

    // B4: Split heal by file — extract distinct source file paths from errors
    const fileRe = /\/src\/[\w./-]+\.(ts|tsx|js|jsx)/g;
    const files = new Set<string>();
    for (const m of trimmed.matchAll(fileRe)) files.add(m[0]);

    if (files.size >= 2) {
      // One task per file — each agent gets only that file's error context
      const fileErrors = new Map<string, string>();
      for (const f of files) {
        // Extract lines mentioning this file
        const lines = trimmed.split("\n").filter(l => l.includes(f));
        fileErrors.set(f, lines.slice(0, 30).join("\n"));
      }
      return Array.from(fileErrors.entries()).map(([file, errs], i) => ({
        id: `heal-${i}`,
        prompt: `Fix the broken build errors in \`${file}\`. \`${cmd}\` fails:\n\`\`\`\n${errs}\n\`\`\`\nFix every error in this file. Run \`${cmd}\` when done to verify.`,
        type: "heal",
      }));
    }

    return [{
      id: "heal-0",
      prompt: `Fix the broken build. \`${cmd}\` fails after merging parallel work:\n\`\`\`\n${trimmed}\n\`\`\`\nFix every error. Run \`${cmd}\` when done to verify.`,
      type: "heal",
    }];
  }
}

export function detectHealthCommand(cwd: string): string | undefined {
  const has = (p: string) => existsSync(join(cwd, p));
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    const scripts = pkg.scripts || {};
    for (const name of ["typecheck", "check:types", "type-check", "build"]) {
      if (scripts[name]) {
        const pm = has("pnpm-lock.yaml") ? "pnpm"
          : has("bun.lockb") || has("bun.lock") ? "bun"
          : has("yarn.lock") ? "yarn" : "npm";
        return `${pm} run ${name}`;
      }
    }
  } catch {}
  if (has("tsconfig.json")) return "npx -y tsc --noEmit";
  if (has("Cargo.toml")) return "cargo check --quiet";
  if (has("go.mod")) return "go build ./...";
  if (has("deno.json") || has("deno.jsonc")) return "deno check .";
  if (has("mix.exs")) return "mix compile --warnings-as-errors";
  return undefined;
}
