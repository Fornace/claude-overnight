import { readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { getPeakPlannerContext, runPlannerQuery } from "../planner/query.js";
import { fmtTokens } from "../ui/render.js";
import { getModelCapability } from "../core/models.js";
import { readRunMemory } from "../state/state.js";
/** Generate a longer narrative summary at run end. Awaited (not fire-and-forget)
 *  because the caller wants the text inline in the final status block. */
export async function generateFinalNarrative(deps, phase) {
    const { cwd, runDir, objective, previousKnowledge, workerModel, fastModel, permissionMode, waveHistory } = deps;
    const debriefModel = fastModel || workerModel;
    const memory = readRunMemory(runDir, previousKnowledge || undefined);
    const cap = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
    const ctx = [
        objective ? `Objective: ${objective}` : "",
        memory.goal ? `Goal:\n${cap(memory.goal, 1200)}` : "",
        memory.status ? `Status:\n${cap(memory.status, 1200)}` : "",
        waveHistory.length ? `Waves completed: ${waveHistory.length}` : "",
        memory.reflections ? `Reflections:\n${cap(memory.reflections, 800)}` : "",
        memory.verifications ? `Verifications:\n${cap(memory.verifications, 800)}` : "",
    ].filter(Boolean).join("\n\n");
    const prompt = `The autonomous run just ended. Final phase: ${phase}.\n\n${ctx}\n\nWrite 3–5 plain sentences for the user: what was accomplished, what's still open, and any follow-ups they should do manually. No bullet points, no preamble, no markdown headers.`;
    try {
        const text = await runPlannerQuery(prompt, { cwd, model: debriefModel, permissionMode }, () => { });
        return text.trim();
    }
    catch {
        return "";
    }
}
export async function printFinalSummary(args) {
    const { runDir, runBranch, objective, waveNum, runStartedAt, branches, waveHistory, accCost, accCompleted, accFailed, accTools, accIn, accOut, remaining, lastCapped, lastAborted, stopping, trulyDone, peakWorkerCtxTokens, peakWorkerCtxPct, currentSwarmLogFile, narrativeDeps, } = args;
    const waves = waveNum + 1;
    const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
    const totalMerged = branches.filter(b => b.status === "merged").length;
    const totalConflicts = branches.filter(b => b.status === "merge-failed").length;
    const termW = Math.max((process.stdout.columns ?? 80) || 80, 50);
    const rule = (c = "─") => chalk.dim(`  ${c.repeat(Math.min(termW - 4, 60))}`);
    const phaseWord = trulyDone ? "complete"
        : remaining <= 0 || lastCapped ? "budget exhausted"
            : stopping || lastAborted ? "interrupted"
                : "stopped";
    process.stdout.write(chalk.dim(`\n  Writing final summary…`));
    const narrative = await generateFinalNarrative(narrativeDeps, phaseWord);
    process.stdout.write("\r" + " ".repeat(40) + "\r");
    console.log("");
    const bannerChar = accFailed === 0 ? "━" : "─";
    const bannerColor = trulyDone ? chalk.green : (stopping || lastAborted) ? chalk.yellow : chalk.magenta;
    console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    if (trulyDone)
        console.log(chalk.bold.green(`  ✓ CLAUDE OVERNIGHT  -- COMPLETE`));
    else if (remaining <= 0 || lastCapped)
        console.log(chalk.bold.yellow(`  ⚠ CLAUDE OVERNIGHT  -- BUDGET EXHAUSTED`));
    else if (stopping || lastAborted)
        console.log(chalk.bold.yellow(`  ⚠ CLAUDE OVERNIGHT  -- INTERRUPTED`));
    else
        console.log(chalk.bold.yellow(`  ⚠ CLAUDE OVERNIGHT  -- STOPPED`));
    console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
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
    console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    if (trulyDone)
        console.log(chalk.bold.green(`  Done. Review the diff, then ship it.`));
    else if (remaining <= 0 || lastCapped)
        console.log(chalk.bold.yellow(`  Paused on budget. Re-run with --resume to continue.`));
    else if (stopping || lastAborted)
        console.log(chalk.bold.yellow(`  Interrupted. --resume to pick up where this left off.`));
    else
        console.log(chalk.bold.yellow(`  Stopped. --resume to continue.`));
    console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
    console.log("");
}
