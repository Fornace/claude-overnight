import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { VERSION } from "../core/_version.js";

export function printVersion(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
  console.log(`claude-overnight v${pkg.version}`);
}

export function printHelp(): void {
  console.log(`
  ${chalk.bold("🌙  claude-overnight")} ${chalk.dim("v" + VERSION + "  -- background lane for your Claude Max plan")}
  ${chalk.dim("─".repeat(60))}

  ${chalk.cyan("Usage")}
    claude-overnight                          ${chalk.dim("interactive mode")}
    claude-overnight tasks.json               ${chalk.dim("task file mode")}
    claude-overnight plan.md                  ${chalk.dim("plan file mode (.md) — coach + flex")}
    claude-overnight "fix auth" "add tests"   ${chalk.dim("inline tasks")}

  ${chalk.cyan("Flags")}
    -h, --help             Show this help
    -v, --version          Print version
    --dry-run              Show planned tasks without running them
    --budget=N             Target number of agent runs ${chalk.dim("(default: 10)")}
    --concurrency=N        Max parallel agents ${chalk.dim("(default: 5)")}
    --model=NAME           Worker model override ${chalk.dim("(interactive mode picks planner + worker separately  -- supports 'Other…' for Qwen / OpenRouter / etc.)")}
    --fast-model=NAME      Fast worker model for quick tasks ${chalk.dim("(optional  -- checked by next wave's workers)")}
    --usage-cap=N          Stop at N% utilization ${chalk.dim("(e.g. 90 to save 10% for other work)")}
    --allow-extra-usage    Allow extra/overage usage ${chalk.dim("(default: stop when plan limits hit)")}
    --extra-usage-budget=N Max $ for extra usage ${chalk.dim("(implies --allow-extra-usage)")}
    --timeout=SECONDS      Agent inactivity timeout ${chalk.dim("(default: 900s, nudges at timeout, kills at 2×)")}
    --flex                 Force adaptive multi-wave planning ${chalk.dim("(steering between waves)")}
    --no-flex              Fixed plan mode ${chalk.dim("(verifier between waves, no re-planning)")}
    --worktrees            Force worktree isolation on ${chalk.dim("(default: auto-detect git repo)")}
    --no-worktrees         Disable worktree isolation ${chalk.dim("(all agents work in real cwd)")}
    --merge=MODE           Merge strategy: yolo or branch ${chalk.dim("(default: yolo)")}
    --yolo                 Shorthand for --no-worktrees
    --no-coach             Skip the setup coach ${chalk.dim("(raw objective, no preflight rewrite)")}
    --coach-model          Re-pick coach model ${chalk.dim("(overrides saved choice)")}

  ${chalk.cyan("Defaults")} ${chalk.dim("(non-interactive)")}
    model: first available    concurrency: 5    worktrees: auto    merge: yolo
    `);
}
