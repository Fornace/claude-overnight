import chalk from "chalk";
import { modelDisplayName, formatContextWindow } from "../core/models.js";
import { fetchModels, ask, select, BRAILLE } from "./cli.js";
import { pickModel } from "../providers/index.js";
/** Interactively edit all mutable run settings. Mutates `options.current` in place. */
export async function editRunSettings(options) {
    const s = options.current;
    const modelsPromise = fetchModels(20_000).catch(() => []);
    let modelFrame = 0;
    const modelSpinner = setInterval(() => {
        process.stdout.write(`\x1B[2K\r  ${chalk.cyan(BRAILLE[modelFrame++ % BRAILLE.length])} ${chalk.dim("loading models...")}`);
    }, 120);
    let models;
    try {
        models = await modelsPromise;
    }
    finally {
        clearInterval(modelSpinner);
        process.stdout.write(`\x1B[2K\r`);
    }
    const plannerPick = await pickModel(`${chalk.cyan("①")} Planner model ${chalk.dim("(thinking, steering  -- use your strongest)")}:`, models, options.defaults?.plannerModel ?? s.plannerModel);
    s.plannerModel = plannerPick.model;
    s.plannerProviderId = plannerPick.providerId;
    const workerPick = await pickModel(`${chalk.cyan("②")} Worker model ${chalk.dim("(what runs the tasks  -- Qwen 3.6 Plus / OpenRouter / etc via Other…)")}:`, models, options.defaults?.workerModel ?? s.workerModel);
    s.workerModel = workerPick.model;
    s.workerProviderId = workerPick.providerId;
    const suggestFast = !!(options.defaults?.fastModel);
    const fastChoice = await select(`${chalk.cyan("③")} Fast worker model ${chalk.dim("(optional  -- Haiku/Qwen for well-scoped tasks, checked by next wave's workers)")}:`, [
        { name: "Skip", value: "skip", hint: "single-worker mode (main worker handles everything)" },
        { name: "Pick a fast worker", value: "pick", hint: "Haiku, Qwen, or any provider  -- a cheaper, faster second worker" },
    ], suggestFast ? 1 : 0);
    if (fastChoice === "pick") {
        const fastPick = await pickModel(`${chalk.cyan("③b")} Fast worker model:`, models, options.defaults?.fastModel ?? s.fastModel);
        s.fastModel = fastPick.model;
        s.fastProviderId = fastPick.providerId;
    }
    else {
        s.fastModel = undefined;
        s.fastProviderId = undefined;
    }
    if (!options.cliConcurrencySet) {
        const defaultC = options.defaults?.concurrency ?? s.concurrency;
        const concAns = await ask(`\n  ${chalk.cyan("④")} ${chalk.dim("Max concurrency")} ${chalk.dim("[")}${chalk.white(String(defaultC))}${chalk.dim("]:")} `);
        const parsed = parseInt(concAns);
        if (!isNaN(parsed) && parsed >= 1)
            s.concurrency = parsed;
    }
    const coachCap = options.defaults?.usageCap;
    const usageCapItems = [
        { name: "Unlimited", value: undefined, hint: "full capacity, wait through rate limits" },
        { name: "90%", value: 0.9, hint: "leave 10% for other work" },
        { name: "75%", value: 0.75, hint: "conservative, plenty of headroom" },
        { name: "50%", value: 0.5, hint: "use half, keep the rest" },
    ];
    const usageCapDefault = coachCap == null ? 0
        : coachCap >= 0.85 ? 1
            : coachCap >= 0.6 ? 2
                : 3;
    s.usageCap = await select(`${chalk.cyan("⑤")} Usage cap:`, usageCapItems, usageCapDefault);
    const extraChoice = await select(`${chalk.cyan("⑥")} Allow extra usage ${chalk.dim("(billed separately)")}:`, [
        { name: "No", value: "no", hint: "stop when plan limits are reached" },
        { name: "Yes, with $ limit", value: "budget", hint: "set a spending cap" },
        { name: "Yes, unlimited", value: "unlimited", hint: "keep going no matter what" },
    ]);
    if (extraChoice === "budget") {
        const bAns = await ask(`  ${chalk.dim("Max extra usage $:")} `);
        const bVal = parseFloat(bAns);
        s.allowExtraUsage = true;
        s.extraUsageBudget = (!isNaN(bVal) && bVal > 0) ? bVal : 5;
    }
    else if (extraChoice === "unlimited") {
        s.allowExtraUsage = true;
        s.extraUsageBudget = undefined;
    }
    else {
        s.allowExtraUsage = false;
        s.extraUsageBudget = undefined;
    }
    const permItems = [
        { name: "Auto", value: "auto", hint: "accept low-risk, reject high-risk" },
        { name: "Bypass all", value: "bypassPermissions", hint: "agents can run anything (yolo)" },
        { name: "Prompt each", value: "default", hint: "ask for every dangerous op" },
    ];
    const permDefault = options.defaults?.permissionMode === "bypassPermissions" ? 1
        : options.defaults?.permissionMode === "default" ? 2 : 0;
    s.permissionMode = await select(`${chalk.cyan("⑦")} Permissions:`, permItems, permDefault);
    const modelLine = (label, m) => m ? `${chalk.dim(label.padEnd(11))}${chalk.white(m)} ${chalk.dim(`(${formatContextWindow(m)} context)`)}` : null;
    const lines = [
        modelLine("planner", s.plannerModel),
        modelLine("worker", s.workerModel),
        modelLine("fast", s.fastModel),
    ].filter(Boolean);
    console.log();
    for (const l of lines)
        console.log(l);
    const capStr = s.usageCap != null ? `${Math.round(s.usageCap * 100)}%` : "unlimited";
    const extraStr = s.allowExtraUsage ? (s.extraUsageBudget ? `$${s.extraUsageBudget}` : "unlimited") : "off";
    console.log(`  ${chalk.dim("concur     ")}${chalk.white(String(s.concurrency))}`);
    console.log(`  ${chalk.dim("usage cap  ")}${chalk.white(capStr)}`);
    console.log(`  ${chalk.dim("extra      ")}${chalk.white(extraStr)}`);
    console.log(`  ${chalk.dim("perms      ")}${chalk.white(s.permissionMode === "bypassPermissions" ? "yolo" : s.permissionMode)}`);
    console.log();
    return s;
}
/** Format a MutableRunSettings as a compact summary line for the terminal. */
export function formatSettingsSummary(s) {
    const parts = [];
    if (s.fastModel)
        parts.push(`${modelDisplayName(s.plannerModel)} → ${modelDisplayName(s.workerModel)} + ${modelDisplayName(s.fastModel)}`);
    else if (s.workerModel !== s.plannerModel)
        parts.push(`${modelDisplayName(s.workerModel)} → ${modelDisplayName(s.plannerModel)}`);
    else
        parts.push(modelDisplayName(s.workerModel));
    if (s.usageCap != null)
        parts.push(`cap ${Math.round(s.usageCap * 100)}%`);
    parts.push(s.allowExtraUsage ? (s.extraUsageBudget ? `extra $${s.extraUsageBudget}` : "extra ∞") : "no extra");
    if (s.permissionMode !== "auto")
        parts.push(s.permissionMode === "bypassPermissions" ? "yolo" : "prompt");
    return parts.join(chalk.dim(" · "));
}
