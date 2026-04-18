import chalk from "chalk";
import { selectKey, ask } from "../cli/cli.js";
export async function promptBudgetExtension(ctx) {
    const avg = ctx.sessionsUsed > 0 ? ctx.spent / ctx.sessionsUsed : 0;
    const base = ctx.estimate && ctx.estimate > 0
        ? ctx.estimate
        : Math.max(10, Math.round(ctx.budget * 0.2));
    // Wiggle room: 30% buffer, minimum 10, rounded up to a nearest-5.
    const withBuffer = Math.max(10, Math.ceil(base * 1.3));
    const suggested = Math.ceil(withBuffer / 5) * 5;
    const estCost = avg > 0 ? ` · ~$${(suggested * avg).toFixed(2)}` : "";
    const estLine = ctx.estimate != null
        ? chalk.dim(`  Planner estimate: ${ctx.estimate} sessions to complete${avg > 0 ? ` (~$${(ctx.estimate * avg).toFixed(2)} at $${avg.toFixed(2)}/session)` : ""}`)
        : chalk.dim(`  No planner estimate available  -- using default${avg > 0 ? ` (~$${avg.toFixed(2)}/session)` : ""}`);
    console.log("");
    console.log(chalk.yellow(`  Budget exhausted  -- run not yet complete.`));
    console.log(estLine);
    console.log(chalk.dim(`  Continue with ${chalk.bold.white(String(suggested))} more sessions${estCost}? Everything stays the same  -- just hit enter.`));
    const action = await selectKey("", [
        { key: "y", desc: "es (↵)" },
        { key: "c", desc: "ustom" },
        { key: "n", desc: "o  -- stop here" },
    ]);
    if (action === "y")
        return suggested;
    if (action === "n")
        return 0;
    const custom = await ask(`  How many more sessions? ${chalk.dim(`[${suggested}]: `)}`);
    const n = parseInt(custom);
    if (isNaN(n) || n <= 0)
        return suggested;
    return n;
}
