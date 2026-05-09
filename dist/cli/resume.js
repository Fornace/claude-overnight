import { readFileSync } from "fs";
import chalk from "chalk";
import { saveRunState, findIncompleteRuns, showRunHistory, formatTimeAgo, autoMergeBranches, readMdDir, } from "../state/state.js";
import { orchestrate, salvageFromFile } from "../planner/planner.js";
import { setTranscriptRunDir } from "../core/transcripts.js";
import { wrap } from "../ui/primitives.js";
import { selectKey } from "./prompts.js";
import { makeProgressLog } from "./display.js";
import { editRunSettings, printRunSettings } from "./settings.js";
import { tasksJsonPath, designsDir, statusMdPath } from "./run-paths.js";
import { renderPrompt } from "../prompts/load.js";
export function countTasksInFile(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0;
    }
    catch {
        return 0;
    }
}
/** Read the first line / preview of a run's status.md. Returns "" if missing. */
function readStatusPreview(runDir, maxLen, firstLineOnly = false) {
    try {
        const raw = readFileSync(statusMdPath(runDir), "utf-8").trim();
        return (firstLineOnly ? raw.split("\n")[0] : raw).slice(0, maxLen);
    }
    catch {
        return "";
    }
}
export async function promptResumeOverrides(state, cliFlags, argv, noTTY, runDir) {
    // ── Apply CLI flag overrides first ──
    if (cliFlags.model)
        state.workerModel = cliFlags.model;
    if (cliFlags.concurrency) {
        const n = parseInt(cliFlags.concurrency);
        if (n >= 1)
            state.concurrency = n;
    }
    if (cliFlags.budget) {
        const n = parseInt(cliFlags.budget);
        if (n > 0) {
            state.remaining = n;
            state.budget = state.accCompleted + state.accFailed + n;
        }
    }
    if (cliFlags["usage-cap"] != null) {
        const v = parseFloat(cliFlags["usage-cap"]);
        if (!isNaN(v) && v >= 0 && v <= 100)
            state.usageCap = v > 0 ? v / 100 : undefined;
    }
    if (cliFlags["extra-usage-budget"] != null) {
        const v = parseFloat(cliFlags["extra-usage-budget"]);
        if (!isNaN(v) && v > 0) {
            state.extraUsageBudget = v;
            state.allowExtraUsage = true;
        }
    }
    if (argv.includes("--allow-extra-usage"))
        state.allowExtraUsage = true;
    if (noTTY) {
        try {
            saveRunState(runDir, state);
        }
        catch { }
        return;
    }
    // ── Interactive review ──
    const showSummary = () => printRunSettings(state, { header: "Resume settings", remaining: state.remaining });
    showSummary();
    const action = await selectKey("", [
        { key: "r", desc: "esume" },
        { key: "e", desc: "dit" },
        { key: "q", desc: "uit" },
    ]);
    if (action === "q")
        process.exit(0);
    if (action === "r")
        return;
    const settings = {
        workerModel: state.workerModel,
        plannerModel: state.plannerModel,
        fastModel: state.fastModel,
        workerProviderId: state.workerProviderId,
        plannerProviderId: state.plannerProviderId,
        fastProviderId: state.fastProviderId,
        concurrency: state.concurrency,
        usageCap: state.usageCap,
        allowExtraUsage: state.allowExtraUsage ?? false,
        extraUsageBudget: state.extraUsageBudget,
    };
    await editRunSettings({
        current: settings,
        cliConcurrencySet: !!cliFlags.concurrency,
    });
    Object.assign(state, settings);
    try {
        saveRunState(runDir, state);
    }
    catch { }
    console.log(chalk.green("\n  ✓ Settings updated"));
    showSummary();
    console.log();
}
export async function detectResume(input) {
    const { rootDir, cwd, noTTY, tasks, allRuns, completedRuns, cliFlags, argv } = input;
    let resuming = false;
    let replanFromScratch = false;
    let resumeState = null;
    let resumeRunDir;
    let continueObjective;
    const incompleteRuns = findIncompleteRuns(rootDir, cwd);
    // When only completed runs exist, offer to continue from the last one
    if (incompleteRuns.length === 0 && completedRuns.length > 0 && !noTTY && tasks.length === 0) {
        let picked = false;
        while (!picked) {
            const action = await selectKey("", [
                { key: "c", desc: "ontinue last" }, { key: "h", desc: "istory" }, { key: "n", desc: "ew" }, { key: "q", desc: "uit" },
            ]);
            if (action === "q")
                process.exit(0);
            if (action === "h") {
                await showRunHistory(allRuns, cwd, incompleteRuns);
                continue;
            }
            if (action === "c") {
                continueObjective = completedRuns[0].state.objective;
            }
            picked = true;
        }
    }
    if (incompleteRuns.length > 0 && !noTTY && tasks.length === 0) {
        let decided = false;
        while (!decided) {
            if (incompleteRuns.length === 1) {
                const run = incompleteRuns[0];
                const prev = run.state;
                const merged = prev.branches.filter(b => b.status === "merged").length;
                const unmerged = prev.branches.filter(b => b.status === "unmerged").length;
                const failed = prev.branches.filter(b => b.status === "failed" || b.status === "merge-failed").length;
                const obj = prev.objective?.slice(0, 50) || "";
                const ago = formatTimeAgo(prev.startedAt);
                const lastStatus = readStatusPreview(run.dir, 200);
                const planTaskCount = prev.phase === "planning" ? countTasksInFile(tasksJsonPath(run.dir)) : 0;
                console.log(chalk.yellow(`\n  ⚠ Unfinished run`) + chalk.dim(` · ${ago}`));
                const termW = Math.max(process.stdout.columns ?? 80, 60);
                const statusMaxW = Math.min(termW - 8, 80);
                const leftover = prev.currentTasks?.length ?? 0;
                const leftoverNote = prev.phase === "stopped" && leftover > 0
                    ? ` · ${leftover} leftover task${leftover === 1 ? "" : "s"} preserved`
                    : "";
                const phaseLabel = prev.phase === "stopped" ? "interrupted (safe to resume)" : prev.phase;
                const boxLines = prev.phase === "planning" ? [
                    `${obj}${obj.length >= 50 ? "…" : ""}`,
                    `Plan ready · ${planTaskCount} tasks · budget ${prev.budget} · ${prev.concurrency}× concurrent`,
                    `Plan phase · not yet executing`,
                ] : [
                    `${obj}${obj.length >= 50 ? "…" : ""}`,
                    `${prev.accCompleted}/${prev.budget} sessions · ${Math.max(1, (prev.budget ?? 0) - prev.accCompleted)} remaining · $${prev.accCost.toFixed(2)}${leftoverNote}`,
                    `Wave ${prev.waveNum + 1} · ${phaseLabel}`,
                ];
                if (lastStatus) {
                    for (const wl of wrap(lastStatus, statusMaxW))
                        boxLines.push(wl);
                }
                if (merged + unmerged + failed > 0)
                    boxLines.push(`${merged} merged · ${unmerged} unmerged · ${failed} failed`);
                const boxW = Math.max(...boxLines.map(l => l.length)) + 4;
                console.log(chalk.dim(`  ╭${"─".repeat(boxW)}╮`));
                for (const line of boxLines)
                    console.log(chalk.dim("  │") + `  ${line.padEnd(boxW - 2)}` + chalk.dim("│"));
                console.log(chalk.dim(`  ╰${"─".repeat(boxW)}╯`));
                const action = await selectKey("", [{ key: "r", desc: "esume" }, { key: "h", desc: "istory" }, { key: "f", desc: "resh" }, { key: "q", desc: "uit" }]);
                if (action === "q")
                    process.exit(0);
                if (action === "f") {
                    decided = true;
                    break;
                }
                if (action === "h") {
                    await showRunHistory(allRuns, cwd, incompleteRuns);
                    continue;
                }
                resuming = true;
                resumeState = prev;
                resumeRunDir = run.dir;
                decided = true;
            }
            else {
                const shown = incompleteRuns.slice(0, 9);
                console.log(chalk.yellow(`\n  ⚠ ${incompleteRuns.length} unfinished runs${incompleteRuns.length > 9 ? ` (showing newest 9)` : ""}\n`));
                for (let i = 0; i < shown.length; i++) {
                    const s = shown[i].state;
                    const ago = formatTimeAgo(s.startedAt);
                    const obj = s.objective?.slice(0, 50) || "";
                    const merged = s.branches.filter(b => b.status === "merged").length;
                    const lastStatus = readStatusPreview(shown[i].dir, 120, true);
                    console.log(chalk.cyan(`  ${i + 1}`) + `  ${obj}${obj.length >= 50 ? "…" : ""}`);
                    if (s.phase === "planning") {
                        const n = countTasksInFile(tasksJsonPath(shown[i].dir));
                        console.log(chalk.dim(`     plan ready · ${n} tasks · budget ${s.budget} · ${ago} · not yet executing`));
                    }
                    else {
                        console.log(chalk.dim(`     ${s.accCompleted}/${s.budget} · $${s.accCost.toFixed(2)} · ${ago} · ${s.phase} at wave ${s.waveNum + 1}${merged ? ` · ${merged} merged` : ""}`));
                    }
                    if (lastStatus) {
                        const termW = Math.max(process.stdout.columns ?? 80, 60);
                        for (const wl of wrap(lastStatus, termW - 6))
                            console.log(chalk.dim(`     ${wl}`));
                    }
                    console.log("");
                }
                const action = await selectKey(`  ${chalk.dim(`[1-${shown.length}] resume`)}`, [
                    ...shown.map((_, i) => ({ key: String(i + 1), desc: "" })),
                    { key: "h", desc: "istory" }, { key: "f", desc: "resh" }, { key: "q", desc: "uit" },
                ]);
                if (action === "q")
                    process.exit(0);
                if (action === "f") {
                    decided = true;
                    break;
                }
                if (action === "h") {
                    await showRunHistory(allRuns, cwd, incompleteRuns);
                    continue;
                }
                const idx = parseInt(action) - 1;
                if (idx >= 0 && idx < shown.length) {
                    resuming = true;
                    resumeState = shown[idx].state;
                    resumeRunDir = shown[idx].dir;
                    decided = true;
                }
            }
        }
        if (resuming && resumeState && resumeRunDir) {
            // If currentTasks is non-empty, the run was interrupted mid-wave and we
            // already persisted the leftover work — resume executes those directly.
            // Otherwise fall back to tasks.json (planning-phase + legacy stopped runs).
            if (resumeState.currentTasks.length === 0) {
                const loaded = salvageFromFile(tasksJsonPath(resumeRunDir), resumeState.budget, () => { }, "resume");
                if (loaded) {
                    resumeState.currentTasks = loaded;
                    const label = resumeState.phase === "planning" ? "Resuming plan" : `Resuming ${resumeState.phase} run`;
                    console.log(chalk.green(`\n  ✓ ${label} · ${loaded.length} tasks loaded from tasks.json`));
                }
                else if (resumeState.phase === "planning") {
                    // No tasks.json  -- the thinking wave got killed before orchestrate ran.
                    // If design docs survived, re-orchestrate from them (salvages the
                    // thinking spend instead of throwing it away).
                    const designs = readMdDir(designsDir(resumeRunDir));
                    if (!designs || !resumeState.objective) {
                        // Planning died before producing anything — re-run planning from
                        // scratch while keeping all saved settings (model, budget, etc.).
                        console.log(chalk.yellow(`\n  ⚠ Planning-phase run has no tasks or designs — will re-plan from scratch.\n`));
                        replanFromScratch = true;
                    }
                    else {
                        const remainingBudget = Math.max(resumeState.concurrency, resumeState.budget - resumeState.accCompleted);
                        const orchBudget = Math.min(50, Math.max(resumeState.concurrency, Math.ceil(remainingBudget * 0.5)));
                        const flexNote = renderPrompt("_shared/flex-note", { vars: { remainingBudget } });
                        console.log(chalk.cyan(`\n  ◆ Re-orchestrating plan from existing designs...\n`));
                        process.stdout.write("\x1B[?25l");
                        // Route transcripts into the resumed run so this call's events
                        // land alongside the prior run's planning trail.
                        setTranscriptRunDir(resumeRunDir);
                        try {
                            const orchTasks = await orchestrate(resumeState.objective, designs, cwd, resumeState.plannerModel, resumeState.workerModel, orchBudget, resumeState.concurrency, makeProgressLog(), flexNote, tasksJsonPath(resumeRunDir), "orchestrate-resume");
                            resumeState.currentTasks = orchTasks;
                            process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${orchTasks.length} tasks`)}\n`);
                        }
                        catch (err) {
                            process.stdout.write("\x1B[?25h");
                            console.error(chalk.red(`\n  Re-orchestration failed: ${err.message}\n  Start Fresh instead.\n`));
                            process.exit(1);
                        }
                        process.stdout.write("\x1B[?25h");
                    }
                }
            }
            const unmerged = resumeState.branches.filter(b => b.status === "unmerged").length;
            if (unmerged > 0) {
                console.log("");
                autoMergeBranches(cwd, resumeState.branches, msg => console.log(chalk.dim(`  ${msg}`)));
                try {
                    saveRunState(resumeRunDir, resumeState);
                }
                catch { }
            }
            await promptResumeOverrides(resumeState, cliFlags, argv, noTTY, resumeRunDir);
        }
    }
    return { resuming, replanFromScratch, resumeState, resumeRunDir, continueObjective };
}
