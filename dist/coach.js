import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { homedir } from "os";
import chalk from "chalk";
import { runPlannerQuery, attemptJsonParse } from "./planner-query.js";
import { renderWaitingIndicator } from "./render.js";
import { createTurn, beginTurn, endTurn } from "./turns.js";
import { selectKey, ask } from "./cli.js";
import { envFor, isCursorProxyProvider, ensureCursorProxyRunning, PROXY_DEFAULT_URL } from "./providers.js";
// ── URL fetching for plan links in the objective ──
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
async function fetchUrlContent(url, timeoutMs = 5_000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
        clearTimeout(timer);
        if (!resp.ok)
            return null;
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("json"))
            return await resp.text();
        // For HTML, extract body text (rough); for .md/.txt, return raw
        if (ct.includes("text/html")) {
            const html = await resp.text();
            return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
        }
        return (await resp.text()).slice(0, 4000);
    }
    catch {
        return null;
    }
}
// ── User settings (~/.claude/claude-overnight/settings.json) ──
const SETTINGS_DIR = join(homedir(), ".claude", "claude-overnight");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
export function loadUserSettings() {
    try {
        return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveUserSettings(s) {
    try {
        mkdirSync(SETTINGS_DIR, { recursive: true });
        writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf-8");
        try {
            chmodSync(SETTINGS_PATH, 0o600);
        }
        catch { }
    }
    catch { }
}
// ── Coach model (separate from DEFAULT_MODEL so the coach can stay cheap) ──
export const COACH_MODEL = "claude-haiku-4-5";
const COACH_TIMEOUT_MS = 60_000;
const COACH_SOFT_STATUS_MS = 5_000;
// ── Raw schema matching the SKILL.md invocation contract ──
const COACH_SCHEMA = {
    type: "json_schema",
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "improvedObjective", "rationale", "recommended", "checklist", "questions"],
        properties: {
            scope: { type: "string", enum: ["bugfix", "feature-add", "refactor", "audit-and-fix", "migration", "research-and-implement", "polish-and-verify"] },
            improvedObjective: { type: "string" },
            rationale: { type: "string" },
            recommended: {
                type: "object",
                additionalProperties: false,
                required: ["budget", "concurrency", "plannerModel", "workerModel", "fastModel", "flex", "usageCap", "permissionMode"],
                properties: {
                    budget: { type: "integer", minimum: 1 },
                    concurrency: { type: "integer", minimum: 1, maximum: 12 },
                    plannerModel: { type: "string" },
                    workerModel: { type: "string" },
                    fastModel: { type: ["string", "null"] },
                    flex: { type: "boolean" },
                    usageCap: { type: ["number", "null"] },
                    permissionMode: { type: "string", enum: ["auto", "bypassPermissions", "default"] },
                },
            },
            checklist: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "level", "title", "detail", "remediation"],
                    properties: {
                        id: { type: "string" },
                        level: { type: "string", enum: ["blocking", "warning", "info"] },
                        title: { type: "string" },
                        detail: { type: "string" },
                        remediation: { type: "string", enum: ["provider:anthropic", "provider:cursor", "git:dirty", "git:branch", "env:missing", "port:busy", "none"] },
                    },
                },
            },
            questions: { type: "array", items: { type: "string" } },
        },
    },
};
// ── Skill-file resolution ──
export function resolveCoachSkillPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const installRoot = dirname(here); // <pkg>/dist → <pkg>
    const candidates = [
        join(installRoot, "plugins", "claude-overnight", "skills", "coach", "SKILL.md"),
        join(here, "..", "plugins", "claude-overnight", "skills", "coach", "SKILL.md"),
    ];
    for (const p of candidates) {
        try {
            if (existsSync(p))
                return p;
        }
        catch { }
    }
    return null;
}
// ── Validation / coercion of the model output ──
export function validateCoachOutput(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const scopes = ["bugfix", "feature-add", "refactor", "audit-and-fix", "migration", "research-and-implement", "polish-and-verify"];
    if (typeof r.scope !== "string" || !scopes.includes(r.scope))
        return null;
    if (typeof r.improvedObjective !== "string" || r.improvedObjective.trim().length < 5)
        return null;
    if (typeof r.rationale !== "string")
        return null;
    const rec = r.recommended;
    if (!rec || typeof rec !== "object")
        return null;
    const budget = Number(rec.budget);
    const concurrency = Number(rec.concurrency);
    if (!Number.isFinite(budget) || budget < 1)
        return null;
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 12)
        return null;
    if (typeof rec.plannerModel !== "string" || typeof rec.workerModel !== "string")
        return null;
    const fastModel = rec.fastModel == null ? null : (typeof rec.fastModel === "string" ? rec.fastModel : null);
    if (typeof rec.flex !== "boolean")
        return null;
    const usageCap = rec.usageCap == null ? null : (typeof rec.usageCap === "number" && rec.usageCap > 0 && rec.usageCap <= 1 ? rec.usageCap : null);
    const perms = ["auto", "bypassPermissions", "default"];
    if (typeof rec.permissionMode !== "string" || !perms.includes(rec.permissionMode))
        return null;
    const rawChecklist = Array.isArray(r.checklist) ? r.checklist : [];
    const checklist = [];
    for (const item of rawChecklist) {
        if (!item || typeof item !== "object")
            continue;
        const it = item;
        if (typeof it.id !== "string" || typeof it.title !== "string" || typeof it.detail !== "string")
            continue;
        const levels = ["blocking", "warning", "info"];
        if (typeof it.level !== "string" || !levels.includes(it.level))
            continue;
        const rems = ["provider:anthropic", "provider:cursor", "git:dirty", "git:branch", "env:missing", "port:busy", "none"];
        const remediation = (typeof it.remediation === "string" && rems.includes(it.remediation))
            ? it.remediation : "none";
        checklist.push({ id: it.id, level: it.level, title: it.title, detail: it.detail, remediation });
    }
    return {
        improvedObjective: r.improvedObjective.trim(),
        scope: r.scope,
        rationale: r.rationale.trim(),
        recommended: {
            budget: Math.round(budget),
            concurrency: Math.round(concurrency),
            plannerModel: rec.plannerModel,
            workerModel: rec.workerModel,
            fastModel,
            flex: rec.flex,
            usageCap,
            permissionMode: rec.permissionMode,
        },
        checklist,
    };
}
function collectRepoFacts(cwd) {
    const readmeHead = (() => {
        for (const name of ["README.md", "README", "readme.md"]) {
            const p = join(cwd, name);
            try {
                if (existsSync(p))
                    return readFileSync(p, "utf-8").slice(0, 1500);
            }
            catch { }
        }
        return "";
    })();
    const packageJson = (() => {
        try {
            const raw = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
            const deps = { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) };
            const depNames = Object.keys(deps).slice(0, 40);
            return {
                name: typeof raw.name === "string" ? raw.name : undefined,
                scripts: raw.scripts && typeof raw.scripts === "object" ? raw.scripts : undefined,
                depSummary: depNames.join(", "),
            };
        }
        catch {
            return null;
        }
    })();
    const safeExec = (cmd, timeoutMs = 1_500) => {
        try {
            return execSync(cmd, { cwd, timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        }
        catch {
            return "";
        }
    };
    const gitStatus = safeExec("git status --porcelain").slice(0, 800);
    const gitBranch = safeExec("git rev-parse --abbrev-ref HEAD").slice(0, 120);
    const gitLog = safeExec("git log --oneline -20").slice(0, 2000);
    const tree = (() => {
        try {
            return readdirSync(cwd).filter(n => !n.startsWith(".") || n === ".env").slice(0, 60);
        }
        catch {
            return [];
        }
    })();
    const hasEnv = [".env", ".env.local", ".env.development"].some(n => {
        try {
            return existsSync(join(cwd, n));
        }
        catch {
            return false;
        }
    });
    const hasTests = ["tests", "__tests__", "test", "spec"].some(n => {
        try {
            return existsSync(join(cwd, n)) && statSync(join(cwd, n)).isDirectory();
        }
        catch {
            return false;
        }
    });
    const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].filter(n => {
        try {
            return existsSync(join(cwd, n));
        }
        catch {
            return false;
        }
    });
    const priorRuns = (() => {
        try {
            const dir = join(cwd, ".claude-overnight", "runs");
            return readdirSync(dir).length;
        }
        catch {
            return 0;
        }
    })();
    const srcFileCount = (() => {
        const out = safeExec("git ls-files", 2_000);
        if (!out)
            return 0;
        const lines = out.split("\n").filter(Boolean);
        return lines.filter(l => /^(src|app|lib)\//.test(l)).length;
    })();
    return { cwd, readmeHead, packageJson, gitStatus, gitBranch, gitLog, tree, hasEnv, hasTests, lockfiles, priorRuns, srcFileCount };
}
function renderProviders(providers) {
    const lines = [];
    const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
    lines.push(`- Anthropic direct: ${hasAnthropicKey ? "available (env)" : "not configured (no ANTHROPIC_API_KEY / Claude session)"}`);
    if (providers.length === 0) {
        lines.push("- No custom providers saved in ~/.claude/claude-overnight/providers.json");
    }
    else {
        for (const p of providers) {
            const tag = p.cursorProxy ? " · cursor proxy" : (p.useJWT ? " · JWT" : "");
            const keySrc = p.keyEnv ? `env ${p.keyEnv}` : (p.cursorApiKey || p.key ? "stored key" : "no key");
            lines.push(`- ${p.displayName} → model="${p.model}"${tag} (${keySrc})`);
        }
    }
    return lines.join("\n");
}
function renderRepoFacts(f, rawObjective, providers, cliFlags, planContent) {
    const sections = [];
    sections.push(`# Raw user objective\n\n${rawObjective}`);
    if (planContent)
        sections.push(`# Linked plan (fetched from URL in objective)\n\n${planContent}`);
    sections.push(`# Repo facts\n\n- cwd: ${f.cwd}\n- git branch: ${f.gitBranch || "(unknown)"}\n- source files (src|app|lib): ${f.srcFileCount}\n- prior claude-overnight runs: ${f.priorRuns}\n- .env present: ${f.hasEnv}\n- tests dir: ${f.hasTests}\n- lockfiles: ${f.lockfiles.join(", ") || "(none)"}`);
    // CLI flags encode user intent — surface them so the coach can respect constraints.
    if (Object.keys(cliFlags).length > 0) {
        const flagLines = Object.entries(cliFlags).map(([k, v]) => `  --${k}=${v}`).join("\n");
        sections.push(`# CLI flags (user-specified constraints)\n\n${flagLines}`);
    }
    sections.push(`# Available providers (recommend ONLY models the user can reach)\n\n${renderProviders(providers)}`);
    if (f.packageJson) {
        const scripts = f.packageJson.scripts ? Object.entries(f.packageJson.scripts).slice(0, 15).map(([k, v]) => `  ${k}: ${v}`).join("\n") : "(none)";
        sections.push(`# package.json\n\nname: ${f.packageJson.name ?? "(none)"}\n\nscripts:\n${scripts}\n\ndeps: ${f.packageJson.depSummary ?? "(none)"}`);
    }
    if (f.gitStatus)
        sections.push(`# git status --porcelain\n\n${f.gitStatus}`);
    if (f.gitLog)
        sections.push(`# git log (last 20)\n\n${f.gitLog}`);
    if (f.readmeHead)
        sections.push(`# README head\n\n${f.readmeHead}`);
    if (f.tree.length)
        sections.push(`# top-level entries\n\n${f.tree.join(", ")}`);
    return sections.join("\n\n");
}
export async function runSetupCoach(rawObjective, cwd, ctx) {
    const skillPath = resolveCoachSkillPath();
    if (!skillPath) {
        console.log(chalk.dim("  coach skipped: skill unavailable"));
        return null;
    }
    let skill = "";
    try {
        skill = readFileSync(skillPath, "utf-8");
    }
    catch {
        console.log(chalk.dim("  coach skipped: skill unreadable"));
        return null;
    }
    const facts = collectRepoFacts(cwd);
    if (facts.srcFileCount > 1_000_000)
        return null;
    // Fetch any URLs found in the objective so the coach sees plan content, not dead links.
    const urls = rawObjective.match(URL_REGEX) ?? [];
    let planContent = null;
    if (urls.length > 0) {
        const results = await Promise.all(urls.map(u => fetchUrlContent(u, 4_000)));
        const fetched = results.filter(Boolean);
        if (fetched.length > 0) {
            planContent = fetched.map((c, i) => `[URL ${i + 1}: ${urls[i]}]\n${c}`).join("\n\n---\n\n");
        }
    }
    const userMessage = renderRepoFacts(facts, rawObjective, ctx.providers, ctx.cliFlags, planContent);
    const prompt = `${skill}\n\n---\n\n${userMessage}\n\nRespond with the JSON object defined in "Invocation contract" only.`;
    // cursor "auto" maps to a slow thinking-class model for large prompts (182s observed).
    // composer-2-fast gives the same quality for structured JSON at ~8s.
    const CURSOR_FAST_MODEL = "composer-2-fast";
    let model = ctx.coachModel ?? COACH_MODEL;
    const startedAt = Date.now();
    const spinner = setInterval(() => {
        const indicator = renderWaitingIndicator("coach", startedAt, { style: "thinking" });
        process.stdout.write(`\x1B[2K\r  ${indicator}`);
    }, 120);
    if (ctx.coachProvider && isCursorProxyProvider(ctx.coachProvider)) {
        const proxyUrl = ctx.coachProvider.baseURL || PROXY_DEFAULT_URL;
        const proxyUp = await ensureCursorProxyRunning(proxyUrl);
        if (!proxyUp) {
            clearInterval(spinner);
            process.stdout.write(`\x1B[2K\r`);
            console.log(chalk.dim("  coach skipped: proxy failed to start"));
            return null;
        }
        if (model === "auto")
            model = CURSOR_FAST_MODEL;
    }
    let raw;
    const turn = createTurn("coach", "Coach", "coach-0", model);
    beginTurn(turn);
    try {
        const queryPromise = runPlannerQuery(prompt, {
            cwd,
            model,
            permissionMode: "bypassPermissions",
            outputFormat: COACH_SCHEMA,
            transcriptName: "coach",
            maxTurns: 3,
            tools: [],
            env: ctx.coachProvider ? envFor(ctx.coachProvider) : undefined,
            turnId: turn.id,
        }, () => { });
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`coach timed out after ${Math.round(COACH_TIMEOUT_MS / 1000)}s`)), COACH_TIMEOUT_MS);
        });
        raw = await Promise.race([queryPromise, timeout]);
        endTurn(turn, "done");
    }
    catch (err) {
        clearInterval(spinner);
        process.stdout.write(`\x1B[2K\r`);
        endTurn(turn, "error");
        const msg = String(err?.message ?? err).toLowerCase();
        const reason = msg.includes("timed out") ? "timeout"
            : (msg.includes("401") || msg.includes("auth")) ? "auth"
                : "network";
        console.log(chalk.dim(`  coach skipped: ${reason}`));
        return null;
    }
    clearInterval(spinner);
    const elapsedMs = Date.now() - startedAt;
    process.stdout.write(`\x1B[2K\r`);
    const parsed = attemptJsonParse(raw);
    const result = validateCoachOutput(parsed);
    if (!result) {
        console.log(chalk.dim("  coach output malformed — skipping"));
        return null;
    }
    // The coach is advisory: provider issues surface as checklist items.
    // We don't auto-spawn anything (cursor proxy, key prompts, etc.) because
    // the user hasn't picked a provider yet — that happens in the pickers,
    // and each provider flow already runs its own setup when actually selected.
    renderCoachBlock(result, elapsedMs, model);
    const choice = await selectKey("", [
        { key: "y", desc: " accept" },
        { key: "e", desc: "dit objective" },
        { key: "s", desc: "kip coach" },
        { key: "x", desc: " skip coach forever" },
    ]);
    if (choice === "y") {
        saveUserSettings({ ...loadUserSettings(), lastCoachedAt: Date.now() });
        return result;
    }
    if (choice === "e") {
        const amend = (await ask(`\n  ${chalk.cyan(">")} what would you change? `)).trim();
        if (!amend)
            return null;
        const amendedPrompt = `${prompt}\n\n---\n\nUser amendment (apply and return a revised JSON object):\n${amend}`;
        const amendTurn = createTurn("coach", "Coach (amended)", "coach-amend-0", model);
        beginTurn(amendTurn);
        try {
            const coachEnv = ctx.coachProvider ? envFor(ctx.coachProvider) : undefined;
            const raw2 = await Promise.race([
                runPlannerQuery(amendedPrompt, {
                    cwd, model, permissionMode: "bypassPermissions",
                    outputFormat: COACH_SCHEMA, transcriptName: "coach-retry", maxTurns: 3, tools: [],
                    env: coachEnv,
                    turnId: amendTurn.id,
                }, () => { }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("coach amendment timed out")), COACH_TIMEOUT_MS)),
            ]);
            endTurn(amendTurn, "done");
            const parsed2 = attemptJsonParse(raw2);
            const result2 = validateCoachOutput(parsed2);
            if (result2) {
                renderCoachBlock(result2, Date.now() - startedAt, model);
                const confirm = await selectKey("", [
                    { key: "y", desc: " accept" },
                    { key: "s", desc: "kip coach" },
                ]);
                if (confirm === "y") {
                    saveUserSettings({ ...loadUserSettings(), lastCoachedAt: Date.now() });
                    return result2;
                }
            }
            else {
                console.log(chalk.dim("  coach amendment malformed — falling through"));
            }
        }
        catch {
            console.log(chalk.dim("  coach amendment failed — falling through"));
            endTurn(amendTurn, "error");
        }
        return null;
    }
    if (choice === "x") {
        saveUserSettings({ ...loadUserSettings(), skipCoach: true });
        console.log(chalk.dim("  coach disabled — run `claude-overnight --coach` once to re-enable"));
        return null;
    }
    return null;
}
// ── Rendering ──
function renderCoachBlock(r, elapsedMs, model) {
    const elapsed = (elapsedMs / 1000).toFixed(1);
    console.log(`\n  ${chalk.cyan("⚡")} ${chalk.bold("Coach")} ${chalk.dim(`(${model}, ${elapsed}s)`)}\n`);
    console.log(`  ${chalk.cyan("✦")} ${chalk.bold("Objective")}`);
    for (const line of r.improvedObjective.split("\n")) {
        console.log(`    ${line}`);
    }
    if (r.rationale)
        console.log(`    ${chalk.dim(r.rationale)}`);
    const rec = r.recommended;
    console.log(`\n  ${chalk.cyan("⚙")} ${chalk.bold("Settings")}`);
    const fastStr = rec.fastModel ? `  fast=${rec.fastModel}` : "";
    console.log(`    planner=${rec.plannerModel}  worker=${rec.workerModel}${fastStr}`);
    const capStr = rec.usageCap != null ? `${Math.round(rec.usageCap * 100)}%` : "unlimited";
    console.log(`    budget=${rec.budget}  concurrency=${rec.concurrency}  flex=${rec.flex ? "on" : "off"}  cap=${capStr}`);
    console.log(`    scope: ${r.scope}  perm=${rec.permissionMode}`);
    if (r.checklist.length) {
        console.log(`\n  ${chalk.cyan("🔑")} ${chalk.bold("Preflight")}`);
        for (const item of r.checklist) {
            const mark = item.level === "blocking" ? chalk.red("✗")
                : item.level === "warning" ? chalk.yellow("⚠") : chalk.green("✓");
            console.log(`    ${mark} ${item.title}${item.detail ? chalk.dim(` — ${item.detail}`) : ""}`);
        }
    }
    console.log("");
}
