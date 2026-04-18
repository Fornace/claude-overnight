#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import chalk from "chalk";
import { VERSION } from "./core/_version.js";
import { DEFAULT_MODEL } from "./core/models.js";
import { setPlannerEnvResolver } from "./planner/query.js";
import { setTranscriptRunDir } from "./core/transcripts.js";
import { pickModel, loadProviders, buildEnvResolver, healthCheckCursorProxy, PROXY_DEFAULT_URL, isCursorProxyProvider, bundledComposerProxyShellCommand, warnMacCursorAgentShellPatchIfNeeded, } from "./providers/index.js";
import { executeRun } from "./run/run.js";
import { parseCliFlags, fetchModels, ask, select, selectKey, loadTaskFile, validateConcurrency, isGitRepo, validateGitRepo, showPlan, } from "./cli/cli.js";
import { loadRunState, findOrphanedDesigns, backfillOrphanedPlans, readPreviousRunKnowledge, createRunDir, updateLatestSymlink, } from "./state/state.js";
import { runSetupCoach, loadUserSettings, saveUserSettings, COACH_MODEL } from "./planner/coach/coach.js";
import { editRunSettings, formatSettingsSummary } from "./cli/settings.js";
import { printVersion, printHelp } from "./cli/help.js";
import { detectResume } from "./cli/resume.js";
import { runProviderPreflight } from "./cli/preflight.js";
import { runPlanPhase } from "./cli/plan-phase.js";
async function main() {
    // Do not use ??= — parent shell can set CURSOR_SKIP_KEYCHAIN=0.
    // CI=true is only set in child process envs (proxy, agents) — setting it here
    // kills chalk color detection (supports-color sees CI → returns level 0).
    process.env.CURSOR_SKIP_KEYCHAIN = "1";
    const argv = process.argv.slice(2);
    if (argv.includes("-v") || argv.includes("--version")) {
        printVersion();
        process.exit(0);
    }
    if (argv.includes("-h") || argv.includes("--help")) {
        printHelp();
        process.exit(0);
    }
    const dryRun = argv.includes("--dry-run");
    const { flags: cliFlags, positional: args } = parseCliFlags(argv);
    if (cliFlags.concurrency !== undefined) {
        const n = parseInt(cliFlags.concurrency);
        if (!Number.isInteger(n) || n < 1) {
            console.error(chalk.red(`  --concurrency must be a positive integer`));
            process.exit(1);
        }
    }
    if (cliFlags.timeout !== undefined) {
        const n = parseFloat(cliFlags.timeout);
        if (isNaN(n) || n <= 0) {
            console.error(chalk.red(`  --timeout must be a positive number`));
            process.exit(1);
        }
    }
    // ── Pre-check: warn if saved Cursor providers exist but proxy is down ──
    const savedCursorProviders = loadProviders().filter(isCursorProxyProvider);
    if (savedCursorProviders.length > 0 && !dryRun) {
        warnMacCursorAgentShellPatchIfNeeded();
        const proxyUp = await healthCheckCursorProxy();
        if (!proxyUp) {
            console.warn(chalk.yellow(`\n  ⚠ ${savedCursorProviders.length} Cursor provider(s) saved but proxy is not running at ${PROXY_DEFAULT_URL}`));
            {
                const cmd = bundledComposerProxyShellCommand();
                console.warn(chalk.yellow(cmd ? `    Start bundled proxy: ${cmd}` : `    Run npm install where claude-overnight is installed, then retry`));
            }
            console.warn(chalk.dim(`    (Continuing — you can still use Anthropic models)\n`));
        }
    }
    // ── Load tasks ──
    let tasks = [];
    let fileCfg;
    const jsonFiles = args.filter(a => a.endsWith(".json"));
    if (jsonFiles.length > 1) {
        console.error(chalk.red(`  Multiple task files provided. Only one .json file is supported.`));
        process.exit(1);
    }
    for (const arg of args) {
        if (arg.endsWith(".json")) {
            if (tasks.length > 0) {
                console.error(chalk.red(`  Cannot mix inline tasks with a task file. Use one or the other.`));
                process.exit(1);
            }
            fileCfg = loadTaskFile(arg);
            tasks = fileCfg.tasks;
        }
        else if (!arg.startsWith("-") && existsSync(resolve(arg))) {
            console.error(chalk.red(`  "${arg}" looks like a file but doesn't end in .json. Rename it or quote the string.`));
            process.exit(1);
        }
        else {
            if (fileCfg) {
                console.error(chalk.red(`  Cannot mix inline tasks with a task file. Use one or the other.`));
                process.exit(1);
            }
            tasks.push({ id: String(tasks.length), prompt: arg });
        }
    }
    // ── Mode detection ──
    // Stop the bin.ts startup splash (if any) before printing our header.
    globalThis.__coStopSplash?.();
    console.log(`  ${chalk.bold("🌙  claude-overnight")} ${chalk.dim("v" + VERSION)}`);
    console.log(chalk.dim(`  ${"─".repeat(36)}`));
    const noTTY = !process.stdin.isTTY;
    const nonInteractive = noTTY || fileCfg !== undefined || tasks.length > 0;
    const cwd = fileCfg?.cwd ?? process.cwd();
    const allowedTools = fileCfg?.allowedTools;
    const beforeWave = fileCfg?.beforeWave;
    const afterWave = fileCfg?.afterWave;
    const afterRun = fileCfg?.afterRun;
    if (!existsSync(cwd)) {
        console.error(chalk.red(`  Working directory does not exist: ${cwd}`));
        process.exit(1);
    }
    if (noTTY)
        console.log(chalk.dim("  Non-interactive mode  -- using defaults\n"));
    // ── Run history ──
    const rootDir = join(cwd, ".claude-overnight");
    const runsDir = join(rootDir, "runs");
    // Backfill run.json for pre-1.11.7 orphaned plans so they become visible
    // to the resume picker. One-shot, idempotent, silent if there's nothing.
    const backfilled = backfillOrphanedPlans(rootDir, cwd);
    if (backfilled > 0 && !noTTY) {
        console.log(chalk.dim(`\n  ↻ Recovered ${backfilled} orphaned plan${backfilled > 1 ? "s" : ""} from disk`));
    }
    const allRuns = [];
    try {
        for (const d of readdirSync(runsDir).sort().reverse()) {
            const s = loadRunState(join(runsDir, d));
            if (s)
                allRuns.push({ dir: join(runsDir, d), state: s });
        }
    }
    catch { }
    const completedRuns = allRuns.filter(r => r.state.phase === "done" && r.state.cwd === cwd);
    if (completedRuns.length > 0 && !noTTY) {
        console.log(chalk.dim(`\n  ${completedRuns.length} previous run${completedRuns.length > 1 ? "s" : ""}`));
        for (const r of completedRuns.slice(0, 3)) {
            const date = r.state.startedAt?.slice(0, 10) || "unknown";
            const obj = r.state.objective?.slice(0, 50) || "";
            const cost = r.state.accCost > 0 ? ` · $${r.state.accCost.toFixed(0)}` : "";
            const merged = r.state.branches.filter(b => b.status === "merged").length;
            console.log(chalk.dim(`     ${date} · ${r.state.accCompleted} done · ${merged} merged${cost}${obj ? ` · ${obj}` : ""}${obj.length >= 50 ? "…" : ""}`));
            let status = "";
            try {
                status = readFileSync(join(r.dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 80);
            }
            catch { }
            if (status)
                console.log(chalk.dim(`       ${status}`));
        }
    }
    // ── Resume / continue detection ──
    const { resuming, replanFromScratch, resumeState, resumeRunDir, continueObjective } = await detectResume({
        rootDir, cwd, noTTY, tasks, allRuns, completedRuns, cliFlags, argv,
    });
    // ── Config resolution ──
    let workerModel;
    let plannerModel;
    let fastModel;
    let workerProvider;
    let plannerProvider;
    let fastProvider;
    let budget;
    let concurrency;
    let objective = fileCfg?.objective;
    let usageCap;
    let allowExtraUsage = false;
    let extraUsageBudget;
    let useWorktrees = false;
    let mergeStrategy = "yolo";
    let coachedOriginal;
    let coachedAt;
    if (resuming) {
        workerModel = resumeState.workerModel;
        plannerModel = resumeState.plannerModel;
        fastModel = resumeState.fastModel;
        const saved = loadProviders();
        const resolveProvider = (providerId, role) => {
            if (!providerId)
                return undefined;
            const p = saved.find(s => s.id === providerId);
            if (!p) {
                console.error(chalk.red(`\n  Resume aborted: ${role} provider "${providerId}" is no longer in ~/.claude/claude-overnight/providers.json`));
                console.error(chalk.dim(`  Re-add it via a fresh run's "Other…" flow, or start Fresh instead.\n`));
                process.exit(1);
            }
            return p;
        };
        workerProvider = resolveProvider(resumeState.workerProviderId, "worker");
        plannerProvider = resolveProvider(resumeState.plannerProviderId, "planner");
        fastProvider = resolveProvider(resumeState.fastProviderId, "fast");
        budget = resumeState.budget;
        concurrency = resumeState.concurrency;
        objective = resumeState.objective;
        usageCap = resumeState.usageCap;
        allowExtraUsage = resumeState.allowExtraUsage ?? false;
        extraUsageBudget = resumeState.extraUsageBudget;
        useWorktrees = resumeState.useWorktrees;
        mergeStrategy = resumeState.mergeStrategy;
        coachedOriginal = resumeState.coachedObjective;
        coachedAt = resumeState.coachedAt;
    }
    else if (!nonInteractive) {
        if (continueObjective) {
            console.log(`\n  ${chalk.cyan("①")} ${chalk.bold("What should the agents do?")} ${chalk.dim("(Enter to continue last)")}\n  ${chalk.dim(continueObjective.slice(0, 80))}${continueObjective.length > 80 ? "…" : ""}`);
        }
        const objInput = (await ask(continueObjective
            ? `  ${chalk.cyan(">")} `
            : `\n  ${chalk.cyan("①")} ${chalk.bold("What should the agents do?")}\n  ${chalk.cyan(">")} `)).trim();
        objective = objInput || continueObjective;
        if (!objective) {
            console.error(chalk.red("\n  No objective provided."));
            process.exit(1);
        }
        // ── Setup coach (advisory, any failure falls through to manual flow) ──
        const coachEnabled = !argv.includes("--no-coach") && !loadUserSettings().skipCoach;
        let coachResult = null;
        if (coachEnabled) {
            const settings = loadUserSettings();
            let coachModel = settings.coachModel;
            let coachProvider;
            if (!coachModel || argv.includes("--coach-model")) {
                const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
                const providers = loadProviders();
                const cursorProviders = providers.filter(isCursorProxyProvider);
                const qwenProviders = providers.filter(p => p.model?.toLowerCase().includes("qwen"));
                const options = [];
                if (hasAnthropicKey)
                    options.push({ key: "1", desc: ` — ${COACH_MODEL} (cheapest)` });
                if (qwenProviders.length > 0)
                    options.push({ key: "2", desc: ` — ${qwenProviders[0].displayName} (${qwenProviders[0].model})` });
                if (cursorProviders.length > 0)
                    options.push({ key: "3", desc: ` — ${cursorProviders[0].displayName} (${cursorProviders[0].model})` });
                options.push({ key: "o", desc: "ther…" });
                const choice = await selectKey("  Which model should the coach use?", options);
                if (choice === "o") {
                    const pick = await pickModel(`${chalk.cyan("①b")} Coach model:`, await fetchModels(5_000).catch(() => []), COACH_MODEL);
                    coachModel = pick.model;
                    if (pick.provider) {
                        coachProvider = pick.provider;
                    }
                    else {
                        coachProvider = loadProviders().find(p => p.id === pick.providerId) ?? loadProviders().find(p => p.model === pick.model);
                    }
                }
                else {
                    if (choice === "1") {
                        coachModel = COACH_MODEL;
                    }
                    else if (choice === "2") {
                        coachModel = qwenProviders[0].model;
                        coachProvider = qwenProviders[0];
                    }
                    else if (choice === "3") {
                        coachModel = cursorProviders[0].model;
                        coachProvider = cursorProviders[0];
                    }
                }
                saveUserSettings({ ...settings, coachModel, coachProviderId: coachProvider?.id });
            }
            else if (settings.coachProviderId) {
                coachProvider = loadProviders().find(p => p.id === settings.coachProviderId);
            }
            coachResult = await runSetupCoach(objective, cwd, { providers: loadProviders(), cliFlags, coachModel, coachProvider });
            if (coachResult) {
                coachedOriginal = objective;
                coachedAt = Date.now();
                objective = coachResult.improvedObjective;
            }
        }
        const defaultBudget = coachResult?.recommended.budget ?? 10;
        const budgetAns = await ask(`\n  ${chalk.cyan("②")} ${chalk.dim("Budget")} ${chalk.dim("[")}${chalk.white(String(defaultBudget))}${chalk.dim("]:")} `);
        budget = parseInt(budgetAns) || defaultBudget;
        if (budget < 1) {
            console.error(chalk.red(`  Budget must be a positive number`));
            process.exit(1);
        }
        const cliYolo = argv.includes("--yolo");
        const coach = coachResult?.recommended;
        const settingsDefaults = {
            workerModel: coach?.workerModel ?? DEFAULT_MODEL,
            plannerModel: coach?.plannerModel ?? DEFAULT_MODEL,
            fastModel: coach?.fastModel ?? undefined,
            concurrency: Math.min(coach?.concurrency ?? 5, budget),
            usageCap: coach?.usageCap ?? undefined,
            allowExtraUsage: false,
        };
        const settings = await editRunSettings({
            current: settingsDefaults,
            cliConcurrencySet: !!cliFlags.concurrency,
            defaults: coach ? {
                plannerModel: coach.plannerModel,
                workerModel: coach.workerModel,
                fastModel: coach.fastModel ?? undefined,
                concurrency: Math.min(coach.concurrency, budget),
                usageCap: coach.usageCap,
            } : undefined,
        });
        plannerModel = settings.plannerModel;
        workerModel = settings.workerModel;
        fastModel = settings.fastModel;
        concurrency = settings.concurrency;
        usageCap = settings.usageCap;
        allowExtraUsage = settings.allowExtraUsage;
        extraUsageBudget = settings.extraUsageBudget;
        const savedProviders = loadProviders();
        plannerProvider = settings.plannerProviderId ? savedProviders.find(p => p.id === settings.plannerProviderId) : undefined;
        workerProvider = settings.workerProviderId ? savedProviders.find(p => p.id === settings.workerProviderId) : undefined;
        fastProvider = settings.fastProviderId ? savedProviders.find(p => p.id === settings.fastProviderId) : undefined;
        // ④ Worktrees + merge (skip if --yolo, --worktrees, --no-worktrees, or --merge set)
        const gitRepo = isGitRepo(cwd);
        if (cliYolo || argv.includes("--no-worktrees")) {
            useWorktrees = false;
            mergeStrategy = cliFlags.merge || "yolo";
        }
        else if (argv.includes("--worktrees")) {
            useWorktrees = true;
            mergeStrategy = cliFlags.merge || "yolo";
        }
        else if (gitRepo) {
            const wtChoice = await select(`${chalk.cyan("④b")} Git isolation:`, [
                { name: "Worktrees + yolo merge", value: "wt-yolo", hint: "isolate agents, merge into current branch" },
                { name: "Worktrees + new branch", value: "wt-branch", hint: "isolate agents, merge into a new branch" },
                { name: "No worktrees", value: "no-wt", hint: "all agents share the working directory" },
            ]);
            useWorktrees = wtChoice !== "no-wt";
            mergeStrategy = wtChoice === "wt-branch" ? "branch" : "yolo";
        }
        else {
            useWorktrees = false;
            mergeStrategy = "yolo";
        }
        const inner = formatSettingsSummary(settings);
        const parts2 = [`budget ${budget}`, `${concurrency}×`];
        if (budget > 2)
            parts2.push("flex");
        if (useWorktrees)
            parts2.push(mergeStrategy === "branch" ? "wt→branch" : "wt→yolo");
        else
            parts2.push("no wt");
        if (completedRuns.length > 0)
            parts2.push(`${completedRuns.length} prior`);
        const fullLine = inner + chalk.dim(" · ") + parts2.join(chalk.dim(" · "));
        const innerLen = fullLine.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").length;
        console.log(chalk.dim(`\n  ╭${"─".repeat(innerLen + 4)}╮`));
        console.log(chalk.dim("  │") + `  ${fullLine}  ` + chalk.dim("│"));
        console.log(chalk.dim(`  ╰${"─".repeat(innerLen + 4)}╯`));
    }
    else {
        let models = [];
        if (!cliFlags.model && !fileCfg?.model)
            models = await fetchModels(5_000);
        // Multi-provider default resolution: match current ANTHROPIC_BASE_URL against
        // saved providers first, then fetched models, then other providers, then hardcoded
        // Anthropic default. Adding a new provider to providers.json automatically affects
        // the default without code changes.
        const activeBaseURL = process.env.ANTHROPIC_BASE_URL;
        const savedForCLI = loadProviders();
        const activeProvider = activeBaseURL ? savedForCLI.find(p => p.baseURL === activeBaseURL) : undefined;
        const defaultModel = activeProvider?.model
            ?? models[0]?.value
            ?? savedForCLI.find(p => p !== activeProvider)?.model
            ?? DEFAULT_MODEL;
        workerModel = cliFlags.model ?? fileCfg?.model ?? defaultModel;
        plannerModel = activeProvider?.model ?? models[0]?.value ?? workerModel;
        // Auto-resolve a saved custom provider if --model matches its id or model id.
        // Lets `claude-overnight --model=qwen3-coder-plus` route correctly without a separate flag.
        const matched = savedForCLI.find(p => p.id === workerModel || p.model === workerModel);
        if (matched) {
            workerProvider = matched;
            workerModel = matched.model;
        }
        // Fast model: --fast-model flag
        if (cliFlags["fast-model"]) {
            fastModel = cliFlags["fast-model"];
            const matchedFast = savedForCLI.find(p => p.id === fastModel || p.model === fastModel);
            if (matchedFast) {
                fastProvider = matchedFast;
                fastModel = matchedFast.model;
            }
        }
        concurrency = cliFlags.concurrency ? parseInt(cliFlags.concurrency) : (fileCfg?.concurrency ?? 5);
        budget = cliFlags.budget ? parseInt(cliFlags.budget) : undefined;
        if (budget != null && (isNaN(budget) || budget < 1)) {
            console.error(chalk.red(`  --budget must be a positive integer`));
            process.exit(1);
        }
        const capFlag = cliFlags["usage-cap"];
        if (capFlag != null) {
            const capVal = parseFloat(capFlag);
            if (isNaN(capVal) || capVal < 0 || capVal > 100) {
                console.error(chalk.red(`  --usage-cap must be between 0 and 100 (got ${capFlag})`));
                process.exit(1);
            }
            usageCap = capVal / 100;
        }
        else {
            usageCap = fileCfg?.usageCap != null ? fileCfg.usageCap / 100 : undefined;
        }
        allowExtraUsage = argv.includes("--allow-extra-usage");
        const extraBudgetFlag = cliFlags["extra-usage-budget"];
        if (extraBudgetFlag != null) {
            extraUsageBudget = parseFloat(extraBudgetFlag);
            if (isNaN(extraUsageBudget) || extraUsageBudget <= 0) {
                console.error(chalk.red(`  --extra-usage-budget must be a positive number`));
                process.exit(1);
            }
            allowExtraUsage = true;
        }
    }
    validateConcurrency(concurrency);
    // Resolve useWorktrees, mergeStrategy for non-interactive + non-resume
    if (!resuming && nonInteractive) {
        const yolo = argv.includes("--yolo");
        useWorktrees = argv.includes("--no-worktrees") || yolo ? false
            : argv.includes("--worktrees") ? true
                : (fileCfg?.useWorktrees ?? isGitRepo(cwd));
        mergeStrategy = cliFlags.merge ? cliFlags.merge
            : (fileCfg?.mergeStrategy ?? "yolo");
        if (!["yolo", "branch"].includes(mergeStrategy)) {
            console.error(chalk.red(`  --merge must be yolo or branch (got ${mergeStrategy})`));
            process.exit(1);
        }
    }
    if (useWorktrees)
        validateGitRepo(cwd);
    // Custom-provider routing: build a model→env resolver so planner, worker,
    // and fast queries hit the right endpoint without touching process.env globally.
    const envForModel = buildEnvResolver({ plannerModel, plannerProvider, workerModel, workerProvider, fastModel, fastProvider });
    setPlannerEnvResolver(envForModel);
    // Opt-in preflight: `--preflight` or `RUN_PREFLIGHT=1`. Each provider probe
    // spawns a real query through the proxy and takes ~10s, so skipping by
    // default saves ~30s on cold start. Misconfigurations still surface — just
    // on the first agent dispatch rather than at the loader.
    const wantPreflight = argv.includes("--preflight") || process.env.RUN_PREFLIGHT === "1";
    if (wantPreflight && (plannerProvider || workerProvider || fastProvider)) {
        const { fastDegraded } = await runProviderPreflight({
            plannerModel, plannerProvider, workerModel, workerProvider, fastModel, fastProvider, cwd,
        });
        if (fastDegraded) {
            fastModel = undefined;
            fastProvider = undefined;
        }
    }
    if (nonInteractive) {
        const capStr = usageCap != null ? `  cap=${Math.round(usageCap * 100)}%` : "";
        const extraStr = allowExtraUsage ? (extraUsageBudget ? `  extra=$${extraUsageBudget}` : "  extra=∞") : "  extra=off";
        console.log(chalk.dim(`  ${workerModel}  concurrency=${concurrency}  worktrees=${useWorktrees}  merge=${mergeStrategy}${capStr}${extraStr}`));
    }
    // ── Plan phase ──
    const flex = !argv.includes("--no-flex") && (fileCfg?.flexiblePlan ?? objective != null) && objective != null && (budget ?? 10) > 2;
    const agentTimeoutMs = cliFlags.timeout ? parseFloat(cliFlags.timeout) * 1000 : undefined;
    let thinkingUsed = 0, thinkingCost = 0, thinkingIn = 0, thinkingOut = 0, thinkingTools = 0;
    let thinkingHistory;
    const orphanedDir = !resuming ? findOrphanedDesigns(rootDir) : null;
    const runDir = resuming && resumeRunDir ? resumeRunDir : (orphanedDir ?? createRunDir(rootDir));
    if (resuming && resumeRunDir)
        updateLatestSymlink(rootDir, resumeRunDir);
    // Route all planner/steering stream events to <runDir>/transcripts/*.ndjson
    // so crashes during planning leave a forensic trail and resumes can inspect
    // what the planner was doing mid-flight. See src/transcripts.ts.
    setTranscriptRunDir(runDir);
    const previousKnowledge = readPreviousRunKnowledge(rootDir);
    const needsPlan = tasks.length === 0 && (!resuming || replanFromScratch);
    const designDir = join(runDir, "designs");
    if (needsPlan) {
        const result = await runPlanPhase({
            objective, noTTY, flex, budget, concurrency, cwd,
            plannerModel, workerModel, fastModel,
            plannerProvider, workerProvider, fastProvider,
            usageCap, allowExtraUsage, extraUsageBudget,
            useWorktrees, mergeStrategy, agentTimeoutMs,
            runDir, designDir, previousKnowledge, envForModel,
            coachedOriginal, coachedAt,
        });
        tasks = result.tasks;
        thinkingHistory = result.thinkingHistory;
        thinkingUsed = result.thinkingUsed;
        thinkingCost = result.thinkingCost;
        thinkingIn = result.thinkingIn;
        thinkingOut = result.thinkingOut;
        thinkingTools = result.thinkingTools;
    }
    if (tasks.length === 0 && !resuming) {
        console.error("No tasks provided.");
        process.exit(1);
    }
    if (dryRun) {
        showPlan(tasks);
        console.log(chalk.dim("  --dry-run: exiting without running\n"));
        process.exit(0);
    }
    // ── Execute ──
    await executeRun({
        tasks, objective, budget: budget ?? tasks.length, workerModel, plannerModel, fastModel,
        workerProvider, plannerProvider, fastProvider, concurrency,
        useWorktrees, mergeStrategy, usageCap, allowExtraUsage, extraUsageBudget,
        flex, agentTimeoutMs, cwd, allowedTools, beforeWave, afterWave, afterRun, runDir, previousKnowledge,
        resuming, resumeState: resumeState ?? undefined,
        thinkingUsed, thinkingCost, thinkingIn, thinkingOut, thinkingTools, thinkingHistory,
        runStartedAt: resuming && resumeState?.startedAt ? new Date(resumeState.startedAt).getTime() : Date.now(),
        coachedObjective: coachedOriginal, coachedAt,
    });
}
main().catch((err) => {
    process.stdout.write("\x1B[?25h");
    console.error(chalk.red(err.message || err));
    process.exit(1);
});
