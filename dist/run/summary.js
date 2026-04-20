import { readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { getPeakPlannerContext, runPlannerQuery } from "../planner/query.js";
import { fmtTokens } from "../ui/primitives.js";
import { getModelCapability } from "../core/models.js";
import { readRunMemory } from "../state/state.js";
import { renderPrompt } from "../prompts/load.js";
/** Generate a longer narrative summary at run end. Awaited (not fire-and-forget)
 *  because the caller wants the text inline in the final status block. */
export async function generateFinalNarrative(deps, phase) {
    const { cwd, runDir, objective, previousKnowledge, workerModel, fastModel, waveHistory } = deps;
    const debriefModel = fastModel || workerModel;
    const memory = readRunMemory(runDir, previousKnowledge || undefined);
    const cap = (s, n) => !s ? "" : s.length > n ? s.slice(0, n) + "…" : s;
    const prompt = renderPrompt("50_review/50-2_summary", {
        vars: {
            phase, objective,
            goal: cap(memory.goal, 1200),
            status: cap(memory.status, 1200),
            waveCount: waveHistory.length || "",
            reflections: cap(memory.reflections, 800),
            verifications: cap(memory.verifications, 800),
        },
    });
    try {
        const text = await runPlannerQuery(prompt, { cwd, model: debriefModel }, () => { });
        return text.trim();
    }
    catch {
        return "";
    }
}
export async function printFinalSummary(args) {
    const { runDir, runBranch, objective, waveNum, runStartedAt, branches, waveHistory, accCost, accCompleted, accFailed, accTools, accIn, accOut, remaining, lastCapped, exitReason, peakWorkerCtxTokens, peakWorkerCtxPct, currentSwarmLogFile, narrativeDeps, } = args;
    const waves = waveNum + 1;
    const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
    const totalMerged = branches.filter(b => b.status === "merged").length;
    const totalConflicts = branches.filter(b => b.status === "merge-failed").length;
    const termW = Math.max((process.stdout.columns ?? 80) || 80, 50);
    const rule = (c = "─") => chalk.dim(`  ${c.repeat(Math.min(termW - 4, 60))}`);
    const bannerChar = accFailed === 0 ? "━" : "─";
    // Banner: title + subtitle explaining why the run ended
    const banner = {
        done: { icon: "✓", title: "CLAUDE OVERNIGHT  -- COMPLETE", color: chalk.green, explain: "The planner determined the objective was achieved." },
        "budget-exhausted": { icon: "⚠", title: "CLAUDE OVERNIGHT  -- BUDGET EXHAUSTED", color: chalk.yellow, explain: "All allocated sessions were consumed." },
        "user-interrupted": { icon: "⚠", title: "CLAUDE OVERNIGHT  -- INTERRUPTED", color: chalk.yellow, explain: "You quit mid-run with [q] or a signal." },
        "planner-gave-up": { icon: "⚠", title: "CLAUDE OVERNIGHT  -- PLANNER GAVE UP", color: chalk.magenta, explain: "The planner could not decompose the remaining work into actionable tasks." },
        "circuit-breaker": { icon: "⚠", title: "CLAUDE OVERNIGHT  -- HALTED", color: chalk.red, explain: "2+ consecutive waves produced no merged changes." },
        stalled: { icon: "⚠", title: "CLAUDE OVERNIGHT  -- STALLED", color: chalk.magenta, explain: "No progress detected; the run was halted to preserve budget." },
    }[exitReason] ?? { icon: "⚠", title: "CLAUDE OVERNIGHT  -- STOPPED", color: chalk.magenta, explain: "The run ended without a clear reason." };
    const narrativePhase = exitReason === "done" ? "complete"
        : exitReason === "budget-exhausted" ? "budget exhausted"
            : exitReason === "user-interrupted" ? "interrupted"
                : exitReason === "planner-gave-up" ? "planner gave up"
                    : exitReason === "circuit-breaker" ? "circuit breaker"
                        : exitReason === "stalled" ? "stalled"
                            : "stopped";
    process.stdout.write(chalk.dim(`\n  Writing final summary…`));
    const narrative = await generateFinalNarrative(narrativeDeps, narrativePhase);
    process.stdout.write("\r" + " ".repeat(40) + "\r");
    console.log("");
    console.log(banner.color(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    console.log(chalk.bold(banner.color(`  ${banner.icon} ${banner.title}`)));
    console.log(chalk.dim(`  ${banner.explain}`));
    console.log(banner.color(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    console.log("");
    if (objective) {
        console.log(chalk.bold("  Objective"));
        const objWrapped = objective.replace(/\s+/g, " ").trim();
        const objW = Math.min(termW - 6, 76);
        for (let i = 0; i < objWrapped.length; i += objW)
            console.log(`  ${objWrapped.slice(i, i + objW)}`);
        console.log("");
    }
    if (narrative) {
        console.log(chalk.bold("  What happened"));
        const narrW = Math.min(termW - 6, 76);
        for (const para of narrative.split(/\n\n+/)) {
            const clean = para.replace(/\s+/g, " ").trim();
            if (!clean)
                continue;
            for (let i = 0; i < clean.length; i += narrW)
                console.log(`  ${clean.slice(i, i + narrW)}`);
            console.log("");
        }
    }
    const peakPlanner = getPeakPlannerContext();
    const plannerSafe = peakPlanner.model ? getModelCapability(peakPlanner.model).safeContext : 0;
    const plannerPct = plannerSafe > 0 && peakPlanner.tokens > 0 ? Math.round((peakPlanner.tokens / plannerSafe) * 100) : 0;
    const colorByPct = (pct) => pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
    const fmtCtx = (tok, pct) => {
        if (tok <= 0)
            return chalk.dim("—");
        return colorByPct(pct)(`${fmtTokens(tok)} (${pct}%)`);
    };
    console.log(rule());
    console.log(chalk.bold("  Stats"));
    console.log("");
    const statRows = [
        [chalk.bold("Waves"), String(waves), chalk.bold("Sessions"), `${accCompleted} done${accFailed > 0 ? ` / ${accFailed} failed` : ""}${remaining > 0 ? ` (${remaining} remaining)` : ""}`],
        [chalk.bold("Cost"), chalk.green(`$${accCost.toFixed(2)}`), chalk.bold("Elapsed"), elapsedStr],
        [chalk.bold("Merged"), `${totalMerged} branches`, chalk.bold("Conflicts"), totalConflicts > 0 ? chalk.red(String(totalConflicts)) : chalk.green("0")],
        [chalk.bold("Tokens"), `${fmtTokens(accIn)} in / ${fmtTokens(accOut)} out`, chalk.bold("Tool calls"), String(accTools)],
        [chalk.bold("Peak ctx"), `worker ${fmtCtx(peakWorkerCtxTokens, peakWorkerCtxPct)}`, chalk.bold(""), `planner ${fmtCtx(peakPlanner.tokens, plannerPct)}`],
    ];
    for (const [k1, v1, k2, v2] of statRows)
        console.log(`  ${k1}  ${v1.padEnd(20)}  ${k2}  ${v2}`);
    if (lastCapped)
        console.log(`  ${chalk.yellow(`Overage budget exhausted`)}`);
    console.log("");
    // Per-wave recap — a compact timeline so the user can see effort distribution at a glance.
    if (waveHistory.length > 0) {
        console.log(rule());
        console.log(chalk.bold(`  Waves  `) + chalk.dim(`(${waveHistory.length} total)`));
        console.log("");
        for (const w of waveHistory) {
            const doneCt = w.tasks.filter(t => t.status === "done").length;
            const failed = w.tasks.filter(t => t.status === "error").length;
            const running = w.tasks.filter(t => t.status === "running").length;
            const parts = [];
            if (doneCt)
                parts.push(chalk.green(`✓ ${doneCt}`));
            if (failed)
                parts.push(chalk.red(`✗ ${failed}`));
            if (running)
                parts.push(chalk.blue(`~ ${running}`));
            if (parts.length === 0)
                parts.push(chalk.dim("—"));
            const head = `  ${chalk.dim(`wave ${String(w.wave + 1).padStart(2)}`)}  ${parts.join(" ")}`;
            console.log(head);
            const firstTask = w.tasks[0];
            if (firstTask) {
                const preview = firstTask.prompt.replace(/\s+/g, " ").trim().slice(0, Math.min(termW - 12, 70));
                console.log(chalk.dim(`    ${preview}${w.tasks.length > 1 ? ` (+${w.tasks.length - 1} more)` : ""}`));
            }
        }
        console.log("");
    }
    const statusFile = join(runDir, "status.md");
    try {
        const statusContent = readFileSync(statusFile, "utf-8").trim();
        if (statusContent) {
            console.log(rule());
            console.log(chalk.bold("  Status"));
            console.log("");
            for (const line of statusContent.split("\n"))
                console.log(`  ${line}`);
            console.log("");
        }
    }
    catch { }
    if (totalConflicts > 0) {
        console.log(rule());
        const conflictBranches = branches.filter(b => b.status === "merge-failed");
        console.log(chalk.red(`  Unresolved conflicts:`));
        for (const c of conflictBranches)
            console.log(chalk.red(`    ${c.branch}`));
        console.log(chalk.dim("  git merge <branch> to resolve"));
        console.log("");
    }
    console.log(rule());
    if (runBranch)
        console.log(chalk.dim(`  Branch: ${runBranch}  -- git merge ${runBranch}`));
    console.log(chalk.dim(`  Run: ${runDir}`));
    if (currentSwarmLogFile)
        console.log(chalk.dim(`  Log: ${currentSwarmLogFile}`));
    console.log("");
    console.log(banner.color(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    // Actionable next-steps based on exit reason
    const endMsg = (() => {
        switch (exitReason) {
            case "done":
                return "Review the diff, then ship it.";
            case "budget-exhausted":
                return remaining > 0
                    ? "Budget sessions remaining but usage cap hit. Raise the cap or re-run with --resume."
                    : "All sessions spent. Re-run with --resume to continue, or raise the budget.";
            case "user-interrupted":
                return "Run preserved. Use --resume to pick up where this left off.";
            case "planner-gave-up": {
                const lines = ["Planner could not decompose remaining work."];
                if (remaining > 0)
                    lines.push(`${remaining} sessions unused — the work may be too vague or out of scope.`);
                lines.push("Refine the objective or break it down manually, then re-run.");
                return lines.join(" ");
            }
            case "circuit-breaker":
                return "No changes landed in 2+ waves. Check for merge conflicts or agent errors in the log.";
            case "stalled":
                return "Run halted to preserve budget. Inspect status.md for blockers, then --resume.";
            default:
                return "Run preserved. --resume to continue.";
        }
    })();
    console.log(chalk.bold(banner.color(`  ${endMsg}`)));
    console.log(banner.color(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    console.log("");
}
