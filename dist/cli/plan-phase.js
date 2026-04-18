import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Swarm } from "../swarm/swarm.js";
import { identifyThemes, buildThinkingTasks, orchestrate, planTasks, refinePlan } from "../planner/planner.js";
import { RunDisplay } from "../ui/ui.js";
import { renderSummary } from "../ui/render/render.js";
import { isCursorProxyProvider } from "../providers/index.js";
import { readMdDir, saveRunState } from "../state/state.js";
import { selectKey, ask, showPlan, makeProgressLog, isJWTAuthError } from "./cli.js";
export async function runPlanPhase(input) {
    const { objective, noTTY, flex, budget, concurrency, cwd, plannerModel, workerModel, fastModel, plannerProvider, workerProvider, fastProvider, permissionMode, usageCap, allowExtraUsage, extraUsageBudget, useWorktrees, mergeStrategy, agentTimeoutMs, runDir, designDir, previousKnowledge, envForModel, coachedOriginal, coachedAt, } = input;
    let tasks = [];
    let thinkingHistory;
    let thinkingUsed = 0, thinkingCost = 0, thinkingIn = 0, thinkingOut = 0, thinkingTools = 0;
    // Persist an early planning-phase state so the run is visible to the resume
    // picker even if orchestrate dies before executeRun gets a chance to run.
    // Without this, a crashed plan phase leaves no run.json and the run vanishes
    // from findIncompleteRuns  -- you pay for orchestration and can't see it.
    if (objective) {
        try {
            saveRunState(runDir, {
                id: runDir.split(/[/\\]/).pop() ?? "",
                objective, budget: budget ?? 10, remaining: budget ?? 10,
                workerModel, plannerModel, fastModel,
                workerProviderId: workerProvider?.id, plannerProviderId: plannerProvider?.id,
                fastProviderId: fastProvider?.id,
                concurrency, permissionMode,
                usageCap, allowExtraUsage, extraUsageBudget,
                flex, useWorktrees, mergeStrategy,
                waveNum: 0, currentTasks: [],
                accCost: 0, accCompleted: 0, accFailed: 0,
                accIn: 0, accOut: 0, accTools: 0,
                branches: [],
                phase: "planning",
                startedAt: new Date().toISOString(),
                cwd,
            });
        }
        catch { }
    }
    if (noTTY) {
        console.error(chalk.red("  No tasks provided and stdin is not a TTY."));
        process.exit(1);
    }
    process.stdout.write("\x1B[?25l");
    const planRestore = () => process.stdout.write("\x1B[?25h");
    const useThinking = flex && (budget ?? 10) > concurrency * 3;
    const thinkingCount = useThinking ? Math.min(Math.max(concurrency, Math.ceil((budget ?? 10) * 0.005)), 10) : 0;
    try {
        if (useThinking) {
            // Persist themes as a Markdown doc so a planning-phase crash leaves a
            // readable record (and a future resume can skip identifyThemes).
            const saveThemesMd = (list) => {
                try {
                    writeFileSync(join(runDir, "themes.md"), `# Themes\n\n**Objective:** ${objective}\n\n${list.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n`, "utf-8");
                }
                catch { }
            };
            let themes = await identifyThemes(objective, thinkingCount, cwd, plannerModel, permissionMode, makeProgressLog(), "themes");
            saveThemesMd(themes);
            process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${themes.length} themes`)}\n\n`);
            planRestore();
            let reviewing = true;
            while (reviewing) {
                for (let i = 0; i < themes.length; i++)
                    console.log(chalk.dim(`  ${String(i + 1).padStart(3)}.`) + ` ${themes[i]}`);
                console.log(chalk.dim(`\n  ${thinkingCount} thinking agents → orchestrate → ${(budget ?? 10) - thinkingCount} execution sessions\n`));
                const action = await selectKey(`${chalk.white(`${themes.length} themes`)} ${chalk.dim(`· ${thinkingCount} thinking · ${concurrency} concurrent`)}`, [{ key: "r", desc: "un" }, { key: "e", desc: "dit" }, { key: "c", desc: "hat" }, { key: "q", desc: "uit" }]);
                if (action === "r") {
                    reviewing = false;
                    break;
                }
                if (action === "e") {
                    const feedback = await ask(`\n  ${chalk.bold("What should change?")}\n  ${chalk.cyan(">")} `);
                    if (!feedback)
                        continue;
                    process.stdout.write("\x1B[?25l");
                    try {
                        themes = await identifyThemes(`${objective}\n\nUser feedback: ${feedback}`, thinkingCount, cwd, plannerModel, permissionMode, makeProgressLog(), "themes-refine");
                        saveThemesMd(themes);
                        process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${themes.length} themes`)}\n\n`);
                    }
                    catch (err) {
                        console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`));
                    }
                    planRestore();
                }
                else if (action === "c") {
                    const question = await ask(`\n  ${chalk.bold("Ask about the themes:")}\n  ${chalk.cyan(">")} `);
                    if (!question)
                        continue;
                    process.stdout.write("\x1B[?25l");
                    try {
                        let answer = "";
                        const plannerEnv = envForModel(plannerModel);
                        for await (const msg of query({
                            prompt: `You're planning work for: "${objective}"\n\nThemes identified:\n${themes.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nUser question: ${question}`,
                            options: { cwd, model: plannerModel, permissionMode, persistSession: false, ...(plannerEnv && { env: plannerEnv }) },
                        })) {
                            if (msg.type === "result" && msg.subtype === "success")
                                answer = msg.result || "";
                        }
                        planRestore();
                        if (answer)
                            console.log(chalk.dim(`\n  ${answer.slice(0, 500)}\n`));
                    }
                    catch {
                        planRestore();
                    }
                }
                else {
                    console.log(chalk.dim("\n  Aborted.\n"));
                    process.exit(0);
                }
            }
            process.stdout.write("\x1B[?25l");
            mkdirSync(designDir, { recursive: true });
            const existingDesigns = readMdDir(designDir);
            if (existingDesigns) {
                const designFiles = readdirSync(designDir).filter(f => f.endsWith(".md")).sort();
                console.log(chalk.green(`\n  ✓ Reusing ${designFiles.length} design docs`) + chalk.dim(` (from prior attempt)`));
                for (const f of designFiles) {
                    try {
                        const firstLine = readFileSync(join(designDir, f), "utf-8").split("\n")[0].replace(/^#+\s*/, "").trim();
                        if (firstLine)
                            console.log(chalk.dim(`    ${firstLine.slice(0, 80)}`));
                    }
                    catch { }
                }
                console.log("");
            }
            else {
                const researchModel = fastModel ? workerModel : plannerModel;
                const thinkingTasks = buildThinkingTasks(objective, themes, designDir, researchModel, previousKnowledge || undefined);
                console.log(chalk.cyan(`\n  ◆ Thinking: ${thinkingTasks.length} agents exploring...\n`));
                const thinkingSwarm = new Swarm({
                    tasks: thinkingTasks, concurrency, cwd, model: researchModel, permissionMode,
                    useWorktrees: false, mergeStrategy: "yolo", agentTimeoutMs, usageCap, allowExtraUsage, extraUsageBudget,
                    envForModel,
                    cursorProxy: [plannerProvider, workerProvider, fastProvider].some(p => p && isCursorProxyProvider(p)),
                });
                const thinkRunInfo = { accIn: 0, accOut: 0, accCost: 0, accCompleted: 0, accFailed: 0, sessionsBudget: budget ?? 10, waveNum: -1, remaining: budget ?? 10, model: researchModel, startedAt: Date.now() };
                const thinkDisplay = new RunDisplay(thinkRunInfo, { remaining: 0, usageCap, concurrency, paused: false, dirty: false });
                thinkDisplay.setWave(thinkingSwarm);
                thinkDisplay.start();
                // Save thinking-wave state on every exit path (normal, abort, double-q).
                const saveThinkingState = () => {
                    thinkingUsed = thinkingSwarm.completed + thinkingSwarm.failed;
                    thinkingCost = thinkingSwarm.totalCostUsd;
                    thinkingIn = thinkingSwarm.totalInputTokens;
                    thinkingOut = thinkingSwarm.totalOutputTokens;
                    thinkingTools = thinkingSwarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
                    try {
                        saveRunState(runDir, {
                            id: runDir.split(/[/\\]/).pop() ?? "",
                            objective: objective, budget: budget ?? 10, remaining: (budget ?? 10) - thinkingUsed,
                            workerModel, plannerModel, fastModel,
                            workerProviderId: workerProvider?.id, plannerProviderId: plannerProvider?.id,
                            fastProviderId: fastProvider?.id,
                            concurrency, permissionMode,
                            usageCap, allowExtraUsage, extraUsageBudget,
                            flex, useWorktrees, mergeStrategy,
                            waveNum: 0, currentTasks: [],
                            accCost: thinkingCost, accCompleted: thinkingUsed, accFailed: 0,
                            accIn: thinkingIn, accOut: thinkingOut, accTools: thinkingTools,
                            branches: [],
                            phase: "planning",
                            startedAt: new Date().toISOString(),
                            cwd,
                            coachedObjective: coachedOriginal,
                            coachedAt,
                        });
                    }
                    catch { }
                };
                // Catch double-q / hard exit during thinking wave
                const exitHandler = () => { try {
                    saveThinkingState();
                }
                catch { } };
                process.on("exit", exitHandler);
                try {
                    await thinkingSwarm.run();
                }
                finally {
                    thinkDisplay.pause();
                    console.log(renderSummary(thinkingSwarm));
                    thinkDisplay.stop();
                    saveThinkingState();
                    process.removeListener("exit", exitHandler);
                }
                thinkingHistory = { wave: -1, tasks: thinkingSwarm.agents.map(a => ({ prompt: a.task.prompt.slice(0, 200), status: a.status, filesChanged: a.filesChanged, error: a.error })) };
                if (thinkingSwarm.rateLimitResetsAt) {
                    const waitMs = thinkingSwarm.rateLimitResetsAt - Date.now();
                    if (waitMs > 0) {
                        console.log(chalk.dim(`  Waiting ${Math.ceil(waitMs / 1000)}s for rate limit reset...`));
                        await new Promise(r => setTimeout(r, waitMs + 2000));
                    }
                }
            }
            const designs = readMdDir(designDir);
            const taskFile = join(runDir, "tasks.json");
            if (designs) {
                const orchBudget = Math.min(50, Math.max(concurrency, Math.ceil(((budget ?? 10) - thinkingUsed) * 0.5)));
                const flexNote = `This is wave 1 of an adaptive multi-wave run (total budget: ${(budget ?? 10) - thinkingUsed}). Plan the highest-impact foundational work first. Future waves will iterate based on what's learned.`;
                console.log(chalk.cyan(`\n  ◆ Orchestrating plan...\n`));
                tasks = await orchestrate(objective, designs, cwd, plannerModel, workerModel, permissionMode, orchBudget, concurrency, makeProgressLog(), flexNote, taskFile);
                process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}\n\n`);
            }
            else {
                console.log(chalk.yellow(`\n  No design docs  -- falling back to direct planning\n`));
                const waveBudget = Math.min(50, Math.max(concurrency, Math.ceil(((budget ?? 10) - thinkingUsed) * 0.5)));
                tasks = await planTasks(objective, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, makeProgressLog(), undefined, taskFile);
                process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}\n\n`);
            }
        }
        else {
            const waveBudget = flex ? Math.min(50, Math.max(concurrency, Math.ceil((budget ?? 10) * 0.5))) : budget;
            const flexNote = flex ? `This is wave 1 of an adaptive multi-wave run (total budget: ${budget}). Plan the highest-impact foundational work first. Future waves will iterate, polish, and expand based on what's learned.` : undefined;
            console.log(chalk.cyan(`\n  ◆ Planning${flex ? " wave 1" : ""}...\n`));
            tasks = await planTasks(objective, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, makeProgressLog(), flexNote);
            process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}${flex ? chalk.dim(` · wave 1`) : ""}\n\n`);
            planRestore();
            let reviewing = true;
            while (reviewing) {
                showPlan(tasks);
                const action = await selectKey(`${chalk.white(`${tasks.length} tasks`)} ${chalk.dim(`· ${concurrency} concurrent`)}`, [{ key: "r", desc: "un" }, { key: "e", desc: "dit" }, { key: "c", desc: "hat" }, { key: "q", desc: "uit" }]);
                switch (action) {
                    case "r":
                        reviewing = false;
                        break;
                    case "e": {
                        const feedback = await ask(`\n  ${chalk.bold("What should change?")}\n  ${chalk.cyan(">")} `);
                        if (!feedback)
                            break;
                        console.log(chalk.cyan("\n  ◆ Re-planning...\n"));
                        process.stdout.write("\x1B[?25l");
                        try {
                            tasks = await refinePlan(objective, tasks, feedback, cwd, plannerModel, workerModel, permissionMode, budget, concurrency, makeProgressLog());
                            process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}\n\n`);
                        }
                        catch (err) {
                            console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`));
                        }
                        planRestore();
                        break;
                    }
                    case "c": {
                        const question = await ask(`\n  ${chalk.bold("Ask about the plan:")}\n  ${chalk.cyan(">")} `);
                        if (!question)
                            break;
                        process.stdout.write("\x1B[?25l");
                        try {
                            let answer = "";
                            const plannerEnv = envForModel(plannerModel);
                            for await (const msg of query({
                                prompt: `You planned these tasks for the objective "${objective}":\n${tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n")}\n\nUser question: ${question}`,
                                options: { cwd, model: plannerModel, permissionMode, persistSession: false, ...(plannerEnv && { env: plannerEnv }) },
                            })) {
                                if (msg.type === "result" && msg.subtype === "success")
                                    answer = msg.result || "";
                            }
                            planRestore();
                            if (answer)
                                console.log(chalk.dim(`\n  ${answer.slice(0, 500)}\n`));
                        }
                        catch {
                            planRestore();
                        }
                        break;
                    }
                    case "q":
                        console.log(chalk.dim("\n  Aborted.\n"));
                        process.exit(0);
                }
            }
        }
    }
    catch (err) {
        planRestore();
        if (isJWTAuthError(err))
            console.error(chalk.red(`\n  Authentication failed  -- check your API key or run: claude auth\n`));
        else
            console.error(chalk.red(`\n  Planning failed: ${err.message}\n`));
        process.exit(1);
    }
    return { tasks, thinkingHistory, thinkingUsed, thinkingCost, thinkingIn, thinkingOut, thinkingTools };
}
