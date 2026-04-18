// Core provider management: CRUD, env building, model picker, preflight, env resolver.
// Cursor-specific concerns live in ./cursor-env, ./cursor-proxy, ./cursor-picker.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ask, select } from "../cli/cli.js";
import { getBearerToken, clearTokenCache } from "../core/auth.js";
import { DEFAULT_MODEL } from "../core/models.js";
import { isCursorProxyProvider, resolveCursorAgentToken, cachedAgentPaths, } from "./cursor-env.js";
import { preflightCursorProxyViaHttp } from "./cursor-proxy.js";
import { pickCursorModel } from "./cursor-picker.js";
import { sdkQueryRateLimiter } from "../core/rate-limiter.js";
// Re-export Cursor utilities so callers can keep a single import point.
export { PROXY_DEFAULT_URL, isCursorProxyProvider, bundledComposerProxyShellCommand, readCursorProxyLogTail, warnMacCursorAgentShellPatchIfNeeded, hasCursorAgentToken, getCursorAgentToken, } from "./cursor-env.js";
export { healthCheckCursorProxy, ensureCursorProxyRunning } from "./cursor-proxy.js";
// ── Store ──
const STORE_PATH = join(homedir(), ".claude", "claude-overnight", "providers.json");
export function getStorePath() { return STORE_PATH; }
export function loadProviders() {
    try {
        const raw = readFileSync(STORE_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.providers))
            return parsed.providers.filter(isValidProvider);
    }
    catch { }
    return [];
}
export function saveProvider(p) {
    const all = loadProviders().filter(x => x.id !== p.id);
    all.push(p);
    mkdirSync(join(homedir(), ".claude", "claude-overnight"), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify({ providers: all }, null, 2), "utf-8");
    try {
        chmodSync(STORE_PATH, 0o600);
    }
    catch { }
    clearTokenCache();
}
export function deleteProvider(id) {
    const all = loadProviders().filter(x => x.id !== id);
    if (!existsSync(STORE_PATH))
        return;
    writeFileSync(STORE_PATH, JSON.stringify({ providers: all }, null, 2), "utf-8");
    try {
        chmodSync(STORE_PATH, 0o600);
    }
    catch { }
    clearTokenCache();
}
function isValidProvider(p) {
    return p && typeof p.id === "string" && typeof p.baseURL === "string"
        && typeof p.model === "string" && typeof p.displayName === "string";
}
// ── Key resolution & env building ──
export function resolveKey(p) {
    if (p.keyEnv) {
        const v = process.env[p.keyEnv];
        return v && v.trim() ? v : null;
    }
    return p.key && p.key.trim() ? p.key : null;
}
/**
 * Build the env overrides for a custom provider. Returns a merged env
 * (including current process.env) because the SDK replaces, not merges, when
 * you pass `options.env`.
 */
export function envFor(p) {
    const base = {};
    for (const [k, v] of Object.entries(process.env))
        if (v !== undefined)
            base[k] = v;
    if (p.cursorProxy) {
        base.ANTHROPIC_BASE_URL = p.baseURL;
        const agentTok = resolveCursorAgentToken();
        const bridgeBearer = process.env.CURSOR_BRIDGE_API_KEY?.trim() ||
            p.cursorApiKey?.trim() ||
            agentTok?.trim() ||
            "";
        base.ANTHROPIC_AUTH_TOKEN = bridgeBearer || "unused";
        delete base.ANTHROPIC_API_KEY;
        if (agentTok) {
            base.CURSOR_API_KEY = agentTok;
            base.CURSOR_AUTH_TOKEN = agentTok;
        }
        base.CI = "true";
        base.CURSOR_SKIP_KEYCHAIN = "1";
        // "agent" omits --mode so cursor-agent runs full agentic mode. --mode plan/ask
        // are read-only — Write/Bash calls silently exit 0.
        base.CURSOR_BRIDGE_MODE = "agent";
        // Use system Node.js for the agent subprocess to avoid macOS segfaults.
        const [sysNode, agentJs] = cachedAgentPaths();
        if (sysNode)
            base.CURSOR_AGENT_NODE = sysNode;
        if (agentJs)
            base.CURSOR_AGENT_SCRIPT = agentJs;
        return base;
    }
    const key = resolveKey(p);
    if (!key)
        throw new Error(`Provider "${p.id}" has no API key (${p.keyEnv ? `env ${p.keyEnv} is empty` : "inline key missing"})`);
    base.ANTHROPIC_BASE_URL = p.baseURL;
    if (p.useJWT) {
        base.ANTHROPIC_AUTH_TOKEN = getBearerToken(p.id, p.model, key, p.baseURL);
    }
    else {
        base.ANTHROPIC_AUTH_TOKEN = key;
    }
    delete base.ANTHROPIC_API_KEY;
    // Prevent CURSOR_API_KEY from leaking into non-proxy envs — would trip
    // isCursorProxyEnv false-positive, silently rerouting through direct fetch
    // which ignores outputFormat (no JSON schema enforcement).
    delete base.CURSOR_API_KEY;
    delete base.CURSOR_AUTH_TOKEN;
    return base;
}
/**
 * Show a unified picker: Anthropic models, saved custom providers, Cursor,
 * and an "Other…" entry that walks the user through adding a new provider.
 */
export async function pickModel(label, anthropicModels, currentModelId) {
    for (;;) {
        const saved = loadProviders();
        const items = [];
        for (const m of anthropicModels) {
            items.push({ name: m.displayName, value: { kind: "anthropic", model: m }, hint: m.description });
        }
        // Network-failed fallback: ensure the picker always has at least one Anthropic
        // entry so the user isn't trapped if they cancel the Other… form.
        if (anthropicModels.length === 0) {
            items.push({
                name: DEFAULT_MODEL,
                value: { kind: "anthropic", model: { value: DEFAULT_MODEL, displayName: DEFAULT_MODEL, description: DEFAULT_MODEL + " (model list unavailable)" } },
                hint: DEFAULT_MODEL + "  -- Anthropic model list unavailable",
            });
        }
        for (const p of saved) {
            const keySrc = p.keyEnv ? `env ${p.keyEnv}` : "stored key";
            const cursorTag = p.cursorProxy ? chalk.dim(" · cursor") : "";
            items.push({ name: `${p.displayName}${cursorTag}`, value: { kind: "provider", provider: p }, hint: `${p.model} · ${keySrc}` });
        }
        items.push({ name: chalk.green("Cursor…"), value: { kind: "cursor" }, hint: "Cursor API Proxy — composer, composer-2, auto, etc." });
        items.push({ name: chalk.cyan("Other…"), value: { kind: "other" }, hint: "Qwen 3.6 Plus, OpenRouter, or any Anthropic-compatible endpoint" });
        let defaultIdx = 0;
        if (currentModelId) {
            const i = items.findIndex(it => {
                if (it.value.kind === "anthropic")
                    return it.value.model.value === currentModelId;
                if (it.value.kind === "provider")
                    return it.value.provider.id === currentModelId || it.value.provider.model === currentModelId;
                return false;
            });
            if (i >= 0)
                defaultIdx = i;
        }
        const picked = await select(label, items, defaultIdx);
        if (picked.kind === "anthropic")
            return { model: picked.model.value };
        if (picked.kind === "provider") {
            return { model: picked.provider.model, providerId: picked.provider.id, provider: picked.provider };
        }
        if (picked.kind === "cursor") {
            const cursorPick = await pickCursorModel();
            if (cursorPick)
                return cursorPick;
            continue;
        }
        const added = await promptNewProvider();
        if (added) {
            saveProvider(added);
            return { model: added.model, providerId: added.id, provider: added };
        }
    }
}
async function promptNewProvider() {
    console.log(chalk.dim("\n  Add a custom provider (Anthropic-compatible endpoint)"));
    console.log(chalk.dim("  Leave blank to cancel.\n"));
    const displayName = await ask(`  ${chalk.cyan("Name")} ${chalk.dim("(e.g. 'Qwen Coder'):")} `);
    if (!displayName)
        return null;
    const id = slugify(displayName);
    const baseURLRaw = await ask(`\n  ${chalk.cyan("Base URL")} ${chalk.dim("(e.g. https://dashscope-intl.aliyuncs.com/apps/anthropic for Qwen 3.6 Plus):")} `);
    if (!baseURLRaw)
        return null;
    const baseURL = normalizeBaseURL(baseURLRaw);
    const model = await ask(`\n  ${chalk.cyan("Model id")} ${chalk.dim("(e.g. qwen3.6-plus):")} `);
    if (!model)
        return null;
    const keyMode = await select(`  ${chalk.cyan("API key source")}:`, [
        { name: "Paste key now", value: "inline", hint: "stored plaintext in ~/.claude/claude-overnight/providers.json (0600)" },
        { name: "Read from env var", value: "env", hint: "nothing written to disk" },
    ]);
    if (keyMode === "env") {
        const envName = await ask(`\n  ${chalk.cyan("Env var name")} ${chalk.dim(`(e.g. CO_KEY_${id.toUpperCase()}):`)} `);
        if (!envName)
            return null;
        if (!process.env[envName]) {
            console.log(chalk.yellow(`\n  ⚠ ${envName} is not set in the current shell  -- you'll need to export it before running.`));
        }
        const useJWT = await select(`  ${chalk.cyan("Auth method")}:`, [
            { name: "JWT tokens", value: "jwt", hint: "short-lived tokens, raw keys never passed to agents" },
            { name: "Raw API key", value: "raw", hint: "key sent directly with every request" },
        ]);
        return { id, displayName, baseURL, model, keyEnv: envName, useJWT: useJWT === "jwt" };
    }
    const key = await ask(`\n  ${chalk.cyan("API key")}: `);
    if (!key)
        return null;
    const useJWT = await select(`  ${chalk.cyan("Auth method")}:`, [
        { name: "JWT tokens", value: "jwt", hint: "short-lived tokens, raw keys never passed to agents" },
        { name: "Raw API key", value: "raw", hint: "key sent directly with every request" },
    ]);
    return { id, displayName, baseURL, model, key, useJWT: useJWT === "jwt" };
}
function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "provider";
}
function normalizeBaseURL(raw) {
    let url = raw.trim().replace(/\/+$/, "");
    url = url.replace(/\/v1\/messages$/i, "").replace(/\/messages$/i, "");
    return url;
}
// ── Pre-flight validation ──
/**
 * Cheap auth check: 1-turn query against the provider, fail fast on misconfig.
 */
export async function preflightProvider(p, cwd, timeoutMs = 20_000, opts) {
    // Cursor proxy: direct HTTP POST /v1/messages (no per-check CLI spawn overhead).
    if (isCursorProxyProvider(p)) {
        return preflightCursorProxyViaHttp(p, timeoutMs, opts);
    }
    let env;
    try {
        env = envFor(p);
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
    const keyInfo = p.keyEnv ? `env ${p.keyEnv}` : "stored key";
    opts?.onProgress?.(`checking ${p.model} (${keyInfo})…`);
    let pq;
    const rl = sdkQueryRateLimiter;
    try {
        await rl.waitIfNeeded();
        pq = query({
            prompt: "Reply with exactly the word ok and nothing else.",
            options: {
                cwd,
                model: p.model,
                env,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                maxTurns: 1,
                persistSession: false,
            },
        });
        const stream = pq;
        let elapsed = 0;
        const PROGRESS_INTERVAL_MS = 3_000;
        const progressTimer = setInterval(() => {
            elapsed += PROGRESS_INTERVAL_MS;
            opts?.onProgress?.(`still waiting… (${(elapsed / 1000).toFixed(1)}s)`);
        }, PROGRESS_INTERVAL_MS);
        const consume = (async () => {
            for await (const msg of stream) {
                if (msg.type === "result") {
                    clearInterval(progressTimer);
                    if (msg.subtype !== "success") {
                        return { ok: false, error: String(msg.result || msg.subtype || "unknown error").slice(0, 200) };
                    }
                    return { ok: true };
                }
            }
            clearInterval(progressTimer);
            return { ok: false, error: "no result received" };
        })();
        const timeout = new Promise((resolve) => {
            setTimeout(() => {
                clearInterval(progressTimer);
                try {
                    stream.interrupt().catch(() => stream.close());
                }
                catch { }
                resolve({ ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s` });
            }, timeoutMs);
        });
        return await Promise.race([consume, timeout]);
    }
    catch (err) {
        return { ok: false, error: String(err?.message || err).slice(0, 200) };
    }
    finally {
        rl.record();
        try {
            pq?.close();
        }
        catch { }
    }
}
// ── Env resolver for planner/worker/fast roles ──
/**
 * Build a single resolver that swarm.ts and planner-query.ts share. Maps a
 * model string to the env overrides that should be passed to `query()`.
 * Returns undefined for Anthropic-native models (let the SDK use process.env).
 */
export function buildEnvResolver(opts) {
    const byModel = new Map();
    if (opts.plannerProvider)
        byModel.set(opts.plannerModel, opts.plannerProvider);
    if (opts.workerProvider)
        byModel.set(opts.workerModel, opts.workerProvider);
    if (opts.fastProvider && opts.fastModel)
        byModel.set(opts.fastModel, opts.fastProvider);
    if (byModel.size === 0)
        return () => undefined;
    return (model) => {
        if (!model)
            return undefined;
        const p = byModel.get(model);
        return p ? envFor(p) : undefined;
    };
}
