import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, realpathSync, openSync, statSync, readSync, closeSync } from "fs";
import { createRequire } from "node:module";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "child_process";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ask, select, selectKey } from "./cli.js";
import { getBearerToken, clearTokenCache } from "./auth.js";
import { DEFAULT_MODEL } from "./models.js";
import { CURSOR_PRIORITY_MODELS, CURSOR_KNOWN_MODELS, KNOWN_CURSOR_MODEL_IDS, cursorModelHint, } from "./cursor-models.js";
import { VERSION } from "./_version.js";
import { getProxyPort, buildProxyUrl } from "./proxy-port.js";
/** Cached system Node.js and agent script paths — resolved once, reused across envFor calls. */
let _cachedAgentNode = null;
let _cachedAgentScript = null;
/** Resolve system Node.js and agent index.js paths. Returns [nodePath, scriptPath] or [null, null]. */
function resolveAgentPaths(timeoutMs = 2_000) {
    let nodePath = null;
    let agentJs = null;
    try {
        nodePath = execSync("which node 2>/dev/null", { timeout: timeoutMs, encoding: "utf-8", shell: "bash" }).trim() || null;
        const agentPath = execSync("command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null", {
            timeout: timeoutMs, encoding: "utf-8", shell: "bash",
        }).trim();
        if (agentPath) {
            const agentDir = dirname(realpathSync(agentPath));
            const indexPath = `${agentDir}/index.js`;
            if (existsSync(indexPath))
                agentJs = indexPath;
        }
    }
    catch { }
    return [nodePath, agentJs];
}
/** Run the installed package CLI with `node` (avoids npx/npm invoking extra tooling on macOS). */
function resolveCursorComposerCli() {
    try {
        const require = createRequire(import.meta.url);
        const pkgJson = require.resolve("cursor-composer-in-claude/package.json");
        const root = dirname(pkgJson);
        const cli = join(root, "dist", "cli.js");
        return existsSync(cli) ? cli : null;
    }
    catch {
        return null;
    }
}
/** Version from the dependency bundled with claude-overnight (not `npx` cache). */
function getEmbeddedComposerProxyVersion() {
    try {
        const require = createRequire(import.meta.url);
        const pkgJsonPath = require.resolve("cursor-composer-in-claude/package.json");
        const j = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        return typeof j.version === "string" ? j.version : null;
    }
    catch {
        return null;
    }
}
/** Directory containing this package's `package.json` (works for global and local installs). */
function getClaudeOvernightInstallRoot() {
    return dirname(dirname(fileURLToPath(import.meta.url)));
}
/**
 * Shell command to run the same bundled proxy CLI we spawn in-process (never `npx`/global).
 */
export function bundledComposerProxyShellCommand() {
    const cli = resolveCursorComposerCli();
    if (!cli)
        return null;
    return `node "${cli}"`;
}
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
// ── Key resolution ──
export function resolveKey(p) {
    if (p.keyEnv) {
        const v = process.env[p.keyEnv];
        return v && v.trim() ? v : null;
    }
    return p.key && p.key.trim() ? p.key : null;
}
/**
 * Build the env overrides for a custom provider. Returns a full merged env
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
        // HTTP Authorization to the proxy: bridge env > per-provider > any resolved agent token (env or providers.json).
        const agentTok = resolveCursorAgentToken();
        const bridgeBearer = process.env.CURSOR_BRIDGE_API_KEY?.trim() ||
            p.cursorApiKey?.trim() ||
            agentTok?.trim() ||
            "";
        base.ANTHROPIC_AUTH_TOKEN = bridgeBearer || "unused";
        delete base.ANTHROPIC_API_KEY;
        // Native Cursor agent — same token so SDK and proxy never fall through to Keychain (`cursor-user`).
        if (agentTok) {
            base.CURSOR_API_KEY = agentTok;
            base.CURSOR_AUTH_TOKEN = agentTok;
        }
        // SDK replaces env for subprocesses — force these so nothing inherits a bad CI / skip flag.
        base.CI = "true";
        base.CURSOR_SKIP_KEYCHAIN = "1";
        // Bridge mode controls the agent behavior: "plan" enables tool use (Read,
        // Glob, Grep, Write, Bash), "ask" gives a chat-only assistant. Planner
        // agents and workers must use "plan" so they actually interact with the codebase.
        base.CURSOR_BRIDGE_MODE = "plan";
        // Use system Node.js for agent subprocess to avoid macOS segfaults with
        // bundled Node.js. Resolve lazily.
        if (!_cachedAgentNode || !_cachedAgentScript) {
            const [node, script] = resolveAgentPaths(2_000);
            _cachedAgentNode = node;
            _cachedAgentScript = script;
        }
        if (_cachedAgentNode) {
            base.CURSOR_AGENT_NODE = _cachedAgentNode;
        }
        if (_cachedAgentScript) {
            base.CURSOR_AGENT_SCRIPT = _cachedAgentScript;
        }
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
    return base;
}
/**
 * Show a unified picker: Anthropic models (from SDK), saved custom providers,
 * and an "Other…" entry that walks the user through adding a new provider.
 * Returns the selected model string and, if it's a custom provider, the id.
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
                value: { kind: "anthropic", model: { value: DEFAULT_MODEL, displayName: DEFAULT_MODEL, description: "default (model list unavailable)" } },
                hint: "default  -- Anthropic model list unavailable",
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
            // user cancelled cursor picker — loop back
            continue;
        }
        const added = await promptNewProvider();
        if (added) {
            saveProvider(added);
            return { model: added.model, providerId: added.id, provider: added };
        }
        // user cancelled "Other…"  -- loop back to picker
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
/** Strip trailing slashes and common endpoint suffixes users paste by mistake. */
function normalizeBaseURL(raw) {
    let url = raw.trim().replace(/\/+$/, "");
    url = url.replace(/\/v1\/messages$/i, "").replace(/\/messages$/i, "");
    return url;
}
// ── Pre-flight validation ──
/**
 * Cheap auth check: spawn a 1-turn query against the provider and fail fast
 * if the key is wrong or the endpoint is unreachable. Timeout is aggressive
 * so misconfig doesn't delay the main run.
 */
export async function preflightProvider(p, cwd, timeoutMs = 20_000, opts) {
    // Cursor proxy path: direct HTTP POST /v1/messages instead of spawning a
    // full `claude` CLI subprocess. Same end-to-end validation (proxy + auth +
    // cursor-agent + model) without per-check 1-3s of CLI spawn overhead.
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
    // Show what we're checking
    const keyInfo = p.keyEnv ? `env ${p.keyEnv}` : "stored key";
    opts?.onProgress?.(`checking ${p.model} (${keyInfo})…`);
    let pq;
    try {
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
        // Progress ticker during the wait
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
        try {
            pq?.close();
        }
        catch { }
    }
}
/**
 * Cursor-proxy-only preflight: HTTP POST /v1/messages instead of spawning the
 * `claude` CLI. The proxy spawns its own cursor-agent subprocess per request
 * (see cursor-composer-in-claude agent-runner.js) with no internal queue —
 * callers can safely run these in parallel.
 */
async function preflightCursorProxyViaHttp(p, timeoutMs, opts) {
    opts?.onProgress?.(`checking ${p.model} (proxy auth)…`);
    const baseURL = (p.baseURL || PROXY_DEFAULT_URL).replace(/\/$/, "");
    const key = resolveCursorProxyKey();
    const headers = { "content-type": "application/json" };
    if (key)
        headers["authorization"] = `Bearer ${key}`;
    const controller = new AbortController();
    let elapsed = 0;
    const PROGRESS_INTERVAL_MS = 3_000;
    const progressTimer = setInterval(() => {
        elapsed += PROGRESS_INTERVAL_MS;
        opts?.onProgress?.(`still waiting… (${(elapsed / 1000).toFixed(1)}s)`);
    }, PROGRESS_INTERVAL_MS);
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // max_tokens must accommodate thinking tokens for `*-thinking-*` variants —
        // 1 token leaves zero reasoning budget and crashes the cursor-agent subprocess
        // (observed with claude-opus-4-7-thinking-high: exit code 1 after ~12s).
        const res = await fetch(`${baseURL}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: p.model,
                max_tokens: 4096,
                messages: [{ role: "user", content: "ok" }],
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
        }
        // Drain body so the connection closes cleanly; we don't care about content.
        await res.text().catch(() => "");
        return { ok: true };
    }
    catch (err) {
        if (err?.name === "AbortError") {
            return { ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s` };
        }
        return { ok: false, error: String(err?.message || err).slice(0, 200) };
    }
    finally {
        clearTimeout(deadline);
        clearInterval(progressTimer);
    }
}
// ── Cursor API Proxy ──
export const PROXY_DEFAULT_URL = "http://127.0.0.1:8765";
/** Directory cursor-composer-in-claude uses for its own sessions.log (see env.js). */
function cursorProxyLogDir() {
    return join(homedir(), ".cursor-api-proxy");
}
/** File we write the proxy child's stdout+stderr to (so agent errors aren't lost to stdio:ignore). */
export function cursorProxyOutLogPath() {
    return join(cursorProxyLogDir(), "proxy.out.log");
}
/** cursor-composer-in-claude's default sessions log (request trace + ERROR lines). */
export function cursorProxySessionsLogPath() {
    return join(cursorProxyLogDir(), "sessions.log");
}
function tailFile(path, maxLines, maxBytes = 32_768) {
    try {
        const st = statSync(path);
        const size = st.size;
        const start = size > maxBytes ? size - maxBytes : 0;
        const buf = Buffer.alloc(size - start);
        const fd = openSync(path, "r");
        try {
            readSync(fd, buf, 0, buf.length, start);
        }
        finally {
            try {
                closeSync(fd);
            }
            catch { }
        }
        const text = buf.toString("utf8");
        const lines = text.split("\n").filter(Boolean);
        return lines.slice(-maxLines).join("\n");
    }
    catch {
        return null;
    }
}
/**
 * Read the tail of both proxy logs for diagnostics. Returns a human-readable
 * block with file paths + last lines, or null if neither log exists.
 */
export function readCursorProxyLogTail(linesPerFile = 20) {
    const out = cursorProxyOutLogPath();
    const sess = cursorProxySessionsLogPath();
    const parts = [];
    const outTail = tailFile(out, linesPerFile);
    if (outTail)
        parts.push(`── ${out} (last ${linesPerFile} lines) ──\n${outTail}`);
    const sessTail = tailFile(sess, linesPerFile);
    if (sessTail)
        parts.push(`── ${sess} (last ${linesPerFile} lines) ──\n${sessTail}`);
    return parts.length ? parts.join("\n\n") : null;
}
/** Check if a provider routes through cursor-composer-in-claude. */
export function isCursorProxyProvider(p) {
    return p.cursorProxy === true || p.baseURL === PROXY_DEFAULT_URL;
}
/**
 * Ensure an "account pool" of cloned config dirs exists under
 * `~/.cursor-api-proxy/accounts/pool-{1..N}`. Each clone is just a copy of the
 * user's `~/.cursor/cli-config.json` (has `authInfo.email` so cursor-composer
 * auto-discovers it as an authenticated account).
 *
 * Purpose: cursor-agent subprocesses write their own cli-config.json on every
 * startup via atomic tmp+rename. When N siblings all write to the same file in
 * parallel, rename can lose the race and raise ENOENT. Giving each spawned
 * agent its own CURSOR_CONFIG_DIR (one per pool entry) lets cursor-composer's
 * AccountPool round-robin between them — zero shared writes, zero race.
 *
 * Refreshed every startup so token rotations in ~/.cursor flow through.
 * Returns the list of pool dir paths, or null if the source config is missing.
 */
export function ensureCursorAccountPool(poolSize = 5) {
    if (poolSize <= 0)
        return null;
    const source = join(homedir(), ".cursor", "cli-config.json");
    if (!existsSync(source))
        return null;
    let sourceBuf;
    try {
        sourceBuf = readFileSync(source);
    }
    catch {
        return null;
    }
    const dirs = [];
    for (let i = 1; i <= poolSize; i++) {
        const dir = join(homedir(), ".cursor-api-proxy", "accounts", `pool-${i}`);
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "cli-config.json"), sourceBuf);
            dirs.push(dir);
        }
        catch {
            // skip this slot; pool still works with fewer dirs
        }
    }
    return dirs.length > 0 ? dirs : null;
}
/** True if ~/.zshrc / ~/.zprofile contain the `run_cursor_agent` workaround (see README). */
export function hasCursorMacAgentZshPatch() {
    let combined = "";
    for (const f of [".zshrc", ".zprofile"]) {
        try {
            combined += readFileSync(join(homedir(), f), "utf8");
        }
        catch {
            /* missing */
        }
    }
    return /run_cursor_agent\s*\(/.test(combined) || /alias\s+agent=\s*['"]?run_cursor_agent['"]?/.test(combined);
}
let warnedMacCursorAgentPatch = false;
/**
 * On macOS, if the Cursor `agent` / `cursor-agent` CLI is installed but the zsh
 * workaround is missing, print once. See README: macOS Cursor agent shell patch.
 */
export function warnMacCursorAgentShellPatchIfNeeded() {
    if (warnedMacCursorAgentPatch || process.platform !== "darwin")
        return;
    let agentPath = "";
    try {
        agentPath = execSync("command -v cursor-agent 2>/dev/null || command -v agent 2>/dev/null", {
            encoding: "utf8",
            shell: "bash",
            timeout: 3_000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    }
    catch {
        return;
    }
    if (!agentPath)
        return;
    if (hasCursorMacAgentZshPatch())
        return;
    warnedMacCursorAgentPatch = true;
    console.warn(chalk.yellow("\n  ⚠ macOS: Cursor's `agent` CLI is unreliable with its bundled Node.js."));
    console.warn(chalk.dim("    Append the snippet from README (\"macOS: Cursor agent shell patch\") to ~/.zshrc, then run: source ~/.zshrc"));
    console.warn("");
}
/** Resolve the cursor-composer-in-claude API key from env or providers.json. */
function resolveCursorProxyKey() {
    if (process.env.CURSOR_BRIDGE_API_KEY?.trim())
        return process.env.CURSOR_BRIDGE_API_KEY.trim();
    const saved = loadProviders().find(p => p.cursorProxy);
    if (saved?.cursorApiKey?.trim())
        return saved.cursorApiKey.trim();
    return null;
}
/**
 * Token for the native Cursor `agent` binary — same order as cursor-composer `loadBridgeConfig`
 * (CURSOR_API_KEY → CURSOR_AUTH_TOKEN → bridge / stored). Without a real token the CLI tries
 * login/keychain and macOS may show “Keychain Not Found” for `cursor-user`.
 */
function resolveCursorAgentToken() {
    if (process.env.CURSOR_API_KEY?.trim())
        return process.env.CURSOR_API_KEY.trim();
    if (process.env.CURSOR_AUTH_TOKEN?.trim())
        return process.env.CURSOR_AUTH_TOKEN.trim();
    return resolveCursorProxyKey();
}
/** True when a User API key (or bridge key) is available for Cursor agent + proxy. */
export function hasCursorAgentToken() {
    return resolveCursorAgentToken() != null;
}
/** Resolved token for tests/diagnostics (never log the return value). */
export function getCursorAgentToken() {
    return resolveCursorAgentToken();
}
/** Build fetch options with the cursor proxy auth header if a key is available. */
function cursorProxyFetchOpts() {
    const key = resolveCursorProxyKey();
    return key ? { headers: { Authorization: `Bearer ${key}` } } : {};
}
/**
 * Health check: GET /health on the proxy. Returns true if proxy is reachable.
 * Passes the stored API key so the /health endpoint doesn't return 401.
 */
export async function healthCheckCursorProxy(baseUrl = PROXY_DEFAULT_URL) {
    const url = `${baseUrl.replace(/\/$/, "")}/health`;
    try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000), ...cursorProxyFetchOpts() });
        return res.ok;
    }
    catch {
        return false;
    }
}
/** GET /health JSON — used to detect stale `npx` proxies older than this package's dependency. */
async function getCursorProxyHealthInfo(baseUrl = PROXY_DEFAULT_URL) {
    try {
        const url = `${baseUrl.replace(/\/$/, "")}/health`;
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000), ...cursorProxyFetchOpts() });
        if (!res.ok)
            return null;
        const json = (await res.json());
        return {
            ok: json.ok,
            version: typeof json.version === "string" ? json.version : undefined,
        };
    }
    catch {
        return null;
    }
}
/**
 * If something is listening and we cannot prove it is this install's bundled
 * `cursor-composer-in-claude` (version mismatch or missing `/health.version`),
 * kill the listener and start the bundled CLI. Avoids stale global/`npx` proxies.
 */
async function maybeRestartStaleProxy(baseUrl, url, port) {
    const embedded = getEmbeddedComposerProxyVersion();
    const info = await getCursorProxyHealthInfo(baseUrl);
    const runningV = info?.version;
    if (!embedded) {
        console.log(chalk.dim(JSON.stringify({
            claudeOvernight: VERSION,
            cursorComposerExpected: null,
            cursorComposerRunning: runningV ?? "unknown",
        })));
        return true;
    }
    const trusted = Boolean(runningV && runningV === embedded);
    if (trusted) {
        console.log(chalk.dim(JSON.stringify({
            claudeOvernight: VERSION,
            cursorComposerExpected: embedded,
            cursorComposerRunning: runningV,
        })));
        return true;
    }
    // Never kill an external proxy if the user explicitly allows it — just trust it.
    if (process.env.CURSOR_OVERNIGHT_ALLOW_EXTERNAL_PROXY === "1" && info?.ok) {
        console.log(chalk.yellow(`  ⚠ External proxy detected (v${runningV ?? "unknown"}) on port ${port} — trusting it (CURSOR_OVERNIGHT_ALLOW_EXTERNAL_PROXY=1)`));
        return true;
    }
    // If the user opted out of auto-restart and the external proxy is healthy, skip.
    if (process.env.CURSOR_OVERNIGHT_NO_PROXY_RESTART === "1" && info?.ok && runningV) {
        console.log(chalk.yellow(`  ⚠ External proxy v${runningV} on port ${port} — skipping restart (CURSOR_OVERNIGHT_NO_PROXY_RESTART=1)`));
        return true;
    }
    const reason = !runningV
        ? `proxy does not report a version in /health — replacing with bundled v${embedded}`
        : `running proxy is v${runningV} but this install bundles cursor-composer-in-claude v${embedded}`;
    console.log(chalk.yellow(`  ⚠ ${reason} — restarting…`));
    killProcessOnPort(port, url.hostname);
    await new Promise(r => setTimeout(r, 500));
    return startProxyProcess(baseUrl, url, port);
}
/**
 * Fetch available Cursor models via GET /v1/models on the proxy.
 * Returns model IDs like ["auto", "composer", "composer-2", "opus-4.6", ...].
 */
export async function fetchCursorModels(baseUrl = PROXY_DEFAULT_URL) {
    const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
    try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000), ...cursorProxyFetchOpts() });
        if (!res.ok)
            return [];
        const json = await res.json();
        return (json.data || []).map(m => m.id).filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Try to fetch live Cursor model IDs. Falls back to an empty array — the
 * caller merges with known constants, so the picker always has content.
 *
 * NOTE: `agent --list-models` segfaults with its bundled Node.js binary
 * (exit 139). We work around this by running with the system `node` instead.
 */
async function fetchLiveCursorModels() {
    // Try the proxy first (works when the bundled node doesn't crash)
    const proxyModels = await fetchCursorModels();
    if (proxyModels.length > 0)
        return proxyModels;
    // Fallback: run the cursor-agent CLI with system node
    // Find the agent binary via command -v (alias-safe), then locate its index.js.
    try {
        // command -v handles symlinks and doesn't expand shell aliases
        const agentPath = execSync("command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null", {
            timeout: 3_000, encoding: "utf-8", shell: "bash",
        }).trim();
        if (!agentPath)
            return [];
        // Resolve the directory (realpathSync handles symlinks like agent → cursor-agent)
        const dir = dirname(realpathSync(agentPath));
        // The bundled index.js lives in the same directory as the agent script
        const indexPath = `${dir}/index.js`;
        const raw = execSync(`node "${indexPath}" --list-models 2>/dev/null`, {
            timeout: 10_000, encoding: "utf-8",
        });
        // Strip ANSI escape codes (cursor uses \x1B[2K\r etc.)
        const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
        // Parse lines like "composer-2-fast - Composer 2 Fast"
        const ids = [];
        for (const line of out.split("\n")) {
            const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+/);
            if (match)
                ids.push(match[1]);
        }
        return ids;
    }
    catch { }
    return [];
}
/**
 * Verify something is actually cursor-composer-in-claude (not just any HTTP service on the port).
 * Tries /health first (proxy identity), then falls back to /v1/models shape check.
 * Returns true if it looks like the proxy.
 */
async function verifyCursorProxy(baseUrl = PROXY_DEFAULT_URL) {
    const url = baseUrl.replace(/\/$/, "");
    const opts = cursorProxyFetchOpts();
    // /health is the most reliable proxy identity check — works even when
    // /v1/models fails due to agent subprocess crash (macOS segfault).
    try {
        const res = await fetch(`${url}/health`, { method: "GET", signal: AbortSignal.timeout(3_000), ...opts });
        if (res.ok)
            return true;
    }
    catch { }
    // Fallback: check /v1/models response shape
    try {
        const res = await fetch(`${url}/v1/models`, { method: "GET", signal: AbortSignal.timeout(3_000), ...opts });
        if (!res.ok)
            return false;
        const json = (await res.json());
        return Array.isArray(json["data"]);
    }
    catch {
        return false;
    }
}
/**
 * Kill whatever process is listening on the given port.
 * Uses `lsof` with TCP LISTEN only — plain `lsof -ti :PORT` also matches
 * *clients* whose remote peer is that port, so the first PID can be the
 * caller (e.g. claude-overnight) and `kill -9` would suicide the CLI.
 */
function killProcessOnPort(port, host = "127.0.0.1") {
    try {
        // `-sTCP:LISTEN` is required: `lsof -ti :PORT` includes ESTABLISHED clients to localhost:PORT.
        const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, {
            timeout: 5_000, encoding: "utf-8",
        }).trim().split("\n")[0];
        if (!pid || !/^\d+$/.test(pid))
            return null;
        execSync(`kill -9 ${pid} 2>/dev/null`, { timeout: 5_000 });
        return parseInt(pid, 10);
    }
    catch {
        return null;
    }
}
/**
 * Check whether something is already listening on the proxy port.
 * Returns true if any process bound the port (another instance, Cursor CLI, etc.).
 */
async function isPortInUse(port, host = "127.0.0.1") {
    try {
        const res = await fetch(`http://${host}:${port}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(2_000),
        });
        return res.ok || res.status >= 400; // any response means something is listening
    }
    catch {
        return false;
    }
}
/**
 * Auto-start the cursor-composer-in-claude as a detached background process.
 *
 * Passes CURSOR_AGENT_NODE/SCRIPT so the fork uses system Node.js for the
 * agent subprocess (avoids segfaults with --list-models on macOS).
 *
 * Handles:
 *  - Proxy already running and verified → returns true immediately
 *  - Something on the port but not our proxy → warns, kills, restarts
 *  - Proxy not running → spawns detached, waits for health
 *  - Spawn fails → returns false, caller falls back to manual instructions
 *
 * When `forceRestart` is true, any listener on the port is killed and the
 * bundled proxy is spawned (same as a version mismatch).
 *
 * When `projectRoot` is provided and `baseUrl` is the default, a per-project
 * port is resolved from `.claude-overnight/config.json` so concurrent runs
 * in different repos don't collide on port 8765.
 *
 * Returns true when the proxy is reachable.
 */
export async function ensureCursorProxyRunning(baseUrl = PROXY_DEFAULT_URL, opts) {
    warnMacCursorAgentShellPatchIfNeeded();
    // Resolve per-project port if no explicit base URL was given and projectRoot is available
    const resolvedPort = opts?.projectRoot && baseUrl === PROXY_DEFAULT_URL
        ? getProxyPort(opts.projectRoot)
        : null;
    const effectiveBaseUrl = resolvedPort != null ? buildProxyUrl(resolvedPort) : baseUrl;
    const url = new URL(effectiveBaseUrl);
    const port = resolvedPort ?? (parseInt(url.port, 10) || 80);
    const forceRestart = opts?.forceRestart ?? false;
    // Stale listener may have been started without CURSOR_API_KEY for the agent child.
    // When we have a token, replace the listener by default so the bundled proxy always inherits it.
    // Opt out: CURSOR_OVERNIGHT_NO_PROXY_RESTART=1 (e.g. shared port / external proxy).
    const token = resolveCursorAgentToken();
    const skipTokenRestart = process.env.CURSOR_OVERNIGHT_NO_PROXY_RESTART === "1";
    const effectiveForce = forceRestart || (!!token && !skipTokenRestart);
    if (effectiveForce && resolveCursorComposerCli()) {
        console.log(chalk.dim(`  Replacing listener on port ${port} with bundled cursor-composer-in-claude…`));
        killProcessOnPort(port, url.hostname);
        await new Promise(r => setTimeout(r, 500));
        return startProxyProcess(baseUrl, url, port);
    }
    // Already healthy?
    if (await healthCheckCursorProxy(baseUrl)) {
        return await maybeRestartStaleProxy(baseUrl, url, port);
    }
    // Something bound the port — verify it's actually the cursor proxy
    if (await isPortInUse(port, url.hostname)) {
        const isProxy = await verifyCursorProxy(baseUrl);
        if (isProxy) {
            console.log(chalk.dim(`  Proxy verified at port ${port}`));
            return await maybeRestartStaleProxy(baseUrl, url, port);
        }
        // Stale process on the port — kill it if forceRestart, or try automatically
        if (!forceRestart) {
            console.log(chalk.yellow(`  ⚠ Something is on port ${port} but it's not cursor-composer-in-claude — killing stale process…`));
        }
        const killedPid = killProcessOnPort(port, url.hostname);
        if (killedPid) {
            console.log(chalk.green(`  ✓ Killed stale process PID ${killedPid} on port ${port}`));
            await new Promise(r => setTimeout(r, 500));
            return startProxyProcess(baseUrl, url, port);
        }
        // Couldn't kill (permission denied, already gone) — try starting anyway
        console.log(chalk.yellow(`  ⚠ Couldn't kill process on port ${port} — attempting to start proxy anyway…`));
        return startProxyProcess(baseUrl, url, port);
    }
    // Port is free — auto-start the proxy
    return startProxyProcess(baseUrl, url, port);
}
/** Spawn the proxy process and wait for it to become healthy. */
async function startProxyProcess(baseUrl, url, port) {
    console.log(chalk.yellow(`\n  Proxy not running at ${baseUrl} — starting it for you…`));
    // Resolve system node and agent index.js so the proxy uses system Node.js
    // for the agent subprocess (avoids segfaults with --list-models on macOS).
    const [sysNode, agentJs] = resolveAgentPaths(3_000);
    const apiKeyStored = loadProviders().find(p => p.cursorProxy)?.cursorApiKey;
    const agentToken = resolveCursorAgentToken();
    if (!agentToken) {
        console.log(chalk.red(`  ✗ Cursor proxy needs a User API key so the agent does not use macOS Keychain (\`cursor-user\`).\n` +
            `    Set ${chalk.bold("CURSOR_API_KEY")} (${chalk.dim("Cursor dashboard → Integrations / API Keys")}) ` +
            `or complete the ${chalk.bold("Cursor…")} setup in claude-overnight (saved to providers.json).\n` +
            `    See: ${chalk.dim("https://cursor.com/docs/cli/headless")}`));
        return false;
    }
    const bridgeKey = process.env.CURSOR_BRIDGE_API_KEY?.trim() ||
        apiKeyStored?.trim() ||
        agentToken;
    const keySource = process.env.CURSOR_BRIDGE_API_KEY?.trim()
        ? "env CURSOR_BRIDGE_API_KEY"
        : (apiKeyStored?.trim() ? "providers.json (stored)" : "mirrored from CURSOR_API_KEY / token");
    const proxyVersion = getEmbeddedComposerProxyVersion() ?? "unknown";
    const composerCli = resolveCursorComposerCli();
    if (!composerCli) {
        console.log(chalk.yellow(`  ⚠ cursor-composer-in-claude is not installed (missing from node_modules). Run: npm install`));
        return false;
    }
    let cliResolved;
    try {
        cliResolved = realpathSync(composerCli);
    }
    catch {
        cliResolved = composerCli;
    }
    const proxyEnv = {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
        CI: "true",
        CURSOR_BRIDGE_API_KEY: bridgeKey,
        CURSOR_SKIP_KEYCHAIN: "1",
        // Always set — cursor-composer only forwards these to the agent; spread alone is not enough
        // if the shell omitted CURSOR_API_KEY (GUI launches, etc.).
        CURSOR_API_KEY: agentToken,
        CURSOR_AUTH_TOKEN: agentToken,
        // Use the CLI streaming path (runStreaming), NOT ACP. The ACP path is broken for
        // opus/sonnet *-thinking-*/effort-variant friendly names: cursor-composer's
        // resolveAcpModelConfigValue only matches against ACP `name` fields (e.g.
        // `claude-opus-4-7`), while friendly IDs like `claude-opus-4-7-thinking-high`
        // come from `agent --list-models`. The ACP agent then replies
        // `{error: "Invalid model value: claude-opus-4-7-thinking-high"}` and
        // cursor-composer's acp-client swallows the error to a silent exit-1.
        // The CLI path accepts all friendly names (verified with opus-thinking-high,
        // gemini-3.1-pro, composer-2 via HTTP preflight). Keychain safety is preserved:
        // the CLI path injects keychain-shim-inject.js via NODE_OPTIONS which no-ops
        // /usr/bin/security calls on macOS (cursor-composer/dist/lib/process.js).
        CURSOR_BRIDGE_USE_ACP: "0",
        // Default bridge mode: "plan" enables tool use (Read, Glob, Grep, Write, Bash).
        // "ask" gives a chat-only assistant that doesn't interact with the codebase.
        CURSOR_BRIDGE_MODE: "plan",
        // cursor-composer chat-only mode fakes HOME to a temp dir; on macOS the agent still waits on
        // Keychain (~30s) for `cursor-user` despite CURSOR_API_KEY. Use the real workspace profile.
        CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: "false",
    };
    if (sysNode && agentJs) {
        proxyEnv.CURSOR_AGENT_NODE = sysNode;
        proxyEnv.CURSOR_AGENT_SCRIPT = agentJs;
    }
    // Enable the account pool so parallel cursor-agent subprocesses get
    // separate CURSOR_CONFIG_DIRs — no more cli-config.json write race.
    const pool = ensureCursorAccountPool(5);
    if (pool && !proxyEnv.CURSOR_CONFIG_DIRS) {
        proxyEnv.CURSOR_CONFIG_DIRS = pool.join(",");
    }
    console.log(chalk.dim(JSON.stringify({
        claudeOvernight: VERSION,
        spawnProxy: {
            pkg: "cursor-composer-in-claude",
            version: proxyVersion,
            cliPath: cliResolved,
            nodeExec: process.execPath,
            apiKey: keySource,
            agentCursorKey: "set (CURSOR_API_KEY / bridge / stored)",
            agentPaths: sysNode && agentJs ? { node: sysNode, script: agentJs } : undefined,
            childEnv: {
                CI: proxyEnv.CI,
                CURSOR_SKIP_KEYCHAIN: proxyEnv.CURSOR_SKIP_KEYCHAIN,
                CURSOR_BRIDGE_MODE: proxyEnv.CURSOR_BRIDGE_MODE,
                CURSOR_BRIDGE_USE_ACP: proxyEnv.CURSOR_BRIDGE_USE_ACP,
                CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: proxyEnv.CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE,
                CURSOR_API_KEY: "(set)",
                accountPool: proxyEnv.CURSOR_CONFIG_DIRS ? `${proxyEnv.CURSOR_CONFIG_DIRS.split(",").length} dirs` : "disabled",
            },
        },
    })));
    try {
        // Capture proxy stdout+stderr to a log file — stdio:"ignore" was hiding
        // agent stderr so "cursor_cli_error" responses had no actionable context.
        const logPath = cursorProxyOutLogPath();
        try {
            mkdirSync(dirname(logPath), { recursive: true });
        }
        catch { }
        const logFd = openSync(logPath, "a");
        console.log(chalk.dim(`  Spawning proxy… ${chalk.dim(`(logs: ${logPath})`)}`));
        const child = spawn(process.execPath, [composerCli, "--port", String(port)], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: proxyEnv,
        });
        child.unref(); // let it outlive this process
        closeSync(logFd); // parent no longer needs the FD — child inherited it
        // Wait up to 15s for the proxy to become healthy, showing progress
        const HEALTH_POLL_MS = 500;
        const HEALTH_MAX_POLLS = 30;
        for (let i = 0; i < HEALTH_MAX_POLLS; i++) {
            await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
            const elapsed = ((i + 1) * HEALTH_POLL_MS / 1000).toFixed(1);
            if (await healthCheckCursorProxy(baseUrl)) {
                // /health only checks the HTTP server — verify the agent subprocess is alive too
                if (await verifyCursorProxy(baseUrl)) {
                    console.log(chalk.green(`  ✓ Proxy started (PID ${child.pid}) and healthy after ${elapsed}s`));
                    return true;
                }
                console.log(chalk.yellow(`  ⚠ /health ok but /v1/models failed — agent subprocess broken, continuing to retry…`));
            }
            // Show a dot every 2s to indicate we're still waiting
            if ((i + 1) % 4 === 0) {
                process.stdout.write(chalk.dim(`  · still waiting… (${elapsed}s)\n`));
            }
        }
        console.log(chalk.yellow(`  ⚠ Proxy process spawned (PID ${child.pid}) but not responding after 15s`));
        console.log(chalk.dim(`  It may still be initializing. You can check with: curl ${baseUrl}/health`));
        return false;
    }
    catch (err) {
        console.log(chalk.yellow(`  ⚠ Failed to auto-start proxy: ${String(err?.message || err).slice(0, 100)}`));
        return false;
    }
}
function tryBundledComposerHelp() {
    const cli = resolveCursorComposerCli();
    if (!cli)
        return false;
    try {
        execSync(`node "${cli}" --help`, { stdio: "pipe", timeout: 10_000 });
        return true;
    }
    catch {
        return false;
    }
}
function setupSteps() {
    return [
        {
            label: "Cursor agent CLI",
            check: () => {
                try {
                    execSync("which agent", { stdio: "pipe" });
                    return true;
                }
                catch {
                    return false;
                }
            },
            autoCmd: "curl https://cursor.com/install -fsS | bash",
            manualCmd: "curl https://cursor.com/install -fsS | bash",
            successMsg: "Cursor CLI found",
        },
        {
            label: "Cursor API key",
            check: () => !!resolveCursorAgentToken(),
            autoCmd: "",
            manualCmd: "",
            successMsg: "Cursor API key configured",
        },
        {
            label: "cursor-composer-in-claude (bundled dependency)",
            check: () => tryBundledComposerHelp(),
            autoCmd: "npm install",
            manualCmd: "npm install",
            successMsg: "Bundled proxy package installed",
        },
    ];
}
const CURSOR_KEY_PROVIDER_ID = "cursor";
/** Persist the Cursor API key into providers.json. Updates any existing cursor proxy provider,
 * or creates a sentinel entry so the key survives across sessions. */
function saveCursorApiKey(key) {
    const existing = loadProviders().filter(p => p.cursorProxy);
    if (existing.length > 0) {
        const p = existing[0];
        p.cursorApiKey = key;
        saveProvider(p);
    }
    else {
        const sentinel = {
            id: CURSOR_KEY_PROVIDER_ID,
            displayName: "Cursor (API key)",
            baseURL: PROXY_DEFAULT_URL,
            model: "auto",
            cursorProxy: true,
            cursorApiKey: key,
        };
        saveProvider(sentinel);
    }
}
/** Prompt the user for a Cursor API key and persist it. Returns true if saved. */
async function promptAndSaveCursorKey() {
    console.log(chalk.dim(`  Get your API key from https://cursor.com/dashboard/integrations`));
    console.log(chalk.dim(`  (Scroll to the "API Keys" section at the bottom of the page)\n`));
    const key = await ask(`  ${chalk.cyan("API key")}: `);
    if (key && key.trim()) {
        const trimmed = key.trim();
        process.env.CURSOR_BRIDGE_API_KEY = trimmed;
        saveCursorApiKey(trimmed);
        return true;
    }
    console.log(chalk.yellow("  No key provided — skipped"));
    return false;
}
/**
 * Full install + configure flow for cursor-composer-in-claude.
 * Walks through CLI install, API key config, and proxy start.
 * Only needed when the quick auto-start (`ensureCursorProxyRunning`) fails —
 * e.g. dependencies not installed or the user has no API key yet.
 * Returns true when proxy is running and healthy.
 */
export async function setupCursorProxy() {
    console.log(chalk.dim("\n  Configure cursor-composer-in-claude"));
    console.log(chalk.dim("  " + "─".repeat(40)));
    console.log(chalk.dim("  We need three things: Cursor CLI, an API key, and the proxy server.\n"));
    const steps = setupSteps();
    // ── Step 1: Cursor CLI ──
    const cliStep = steps[0];
    if (cliStep.check()) {
        console.log(chalk.green(`  ✓ ${cliStep.successMsg}`));
    }
    else {
        console.log(chalk.yellow(`\n  ${cliStep.label} not found`));
        const choice = await selectKey(`  Install ${cliStep.label}?`, [
            { key: "a", desc: "uto (run command)" },
            { key: "m", desc: "anual (show command)" },
            { key: "s", desc: "kip (I'll handle it)" },
        ]);
        if (choice === "a") {
            console.log(chalk.dim(`  Running: ${cliStep.autoCmd}`));
            try {
                execSync(cliStep.autoCmd, { stdio: "inherit", timeout: 60_000 });
                console.log(chalk.green(`  ✓ ${cliStep.successMsg}`));
            }
            catch {
                console.log(chalk.yellow("  Command failed — try manual mode"));
            }
        }
        else if (choice === "m") {
            console.log(chalk.cyan(`\n  Run this command:`));
            console.log(chalk.white(`    ${cliStep.manualCmd}\n`));
        }
        else {
            console.log(chalk.dim(`  Skipped: ${cliStep.label}`));
        }
    }
    // ── Step 2: API key ──
    const keyStep = steps[1];
    if (keyStep.check()) {
        console.log(chalk.green(`  ✓ ${keyStep.successMsg}`));
    }
    else {
        console.log(chalk.yellow(`\n  ${keyStep.label} not configured`));
        console.log(chalk.cyan(`  1. Open: https://cursor.com/dashboard/integrations`));
        console.log(chalk.cyan(`  2. Scroll to "API Keys" at the bottom of the page`));
        console.log(chalk.cyan(`  3. Copy your API key and paste it below\n`));
        if (await promptAndSaveCursorKey()) {
            console.log(chalk.green(`  ✓ ${keyStep.successMsg}`));
        }
        else {
            console.log(chalk.yellow("  No API key — the proxy won't authenticate without one."));
        }
    }
    // ── Step 3: Bundled proxy dependency ──
    const proxyStep = steps[2];
    const installRoot = getClaudeOvernightInstallRoot();
    if (proxyStep.check()) {
        console.log(chalk.green(`  ✓ ${proxyStep.successMsg}`));
    }
    else {
        console.log(chalk.yellow(`\n  ${proxyStep.label} missing under node_modules`));
        const choice = await selectKey(`  Run npm install in this claude-overnight install?`, [
            { key: "a", desc: "uto (npm install)" },
            { key: "m", desc: "anual (show commands)" },
            { key: "s", desc: "kip (I'll handle it)" },
        ]);
        if (choice === "a") {
            console.log(chalk.dim(`  Running: npm install in ${installRoot}`));
            try {
                execSync("npm install", { cwd: installRoot, stdio: "inherit", timeout: 180_000 });
            }
            catch {
                console.log(chalk.yellow("  npm install failed."));
                return false;
            }
            if (!tryBundledComposerHelp()) {
                console.log(chalk.yellow("  cursor-composer-in-claude still missing after npm install."));
                return false;
            }
            console.log(chalk.green(`  ✓ ${proxyStep.successMsg}`));
        }
        else if (choice === "m") {
            console.log(chalk.cyan(`\n  From ${chalk.bold(installRoot)}:`));
            console.log(chalk.white(`    ${chalk.bold("npm install")}`));
            const cmd = bundledComposerProxyShellCommand();
            if (cmd)
                console.log(chalk.white(`    ${chalk.bold(cmd)}\n`));
            const ok = await selectKey(`  Done?`, [
                { key: "r", desc: "eady" },
                { key: "c", desc: "ancel" },
            ]);
            if (ok === "c")
                return false;
        }
        else {
            console.log(chalk.dim(`  Skipped: ${proxyStep.label}`));
            return false;
        }
    }
    // Auto-start the proxy (detached — only the bundled CLI)
    if (await ensureCursorProxyRunning())
        return true;
    const manual = bundledComposerProxyShellCommand();
    console.log(chalk.yellow(`\n  Couldn't start the proxy automatically.`));
    console.log(chalk.cyan(`  Ensure dependencies: ${chalk.bold(`cd "${installRoot}" && npm install`)}`));
    if (manual)
        console.log(chalk.cyan(`  Start bundled proxy: ${chalk.bold(manual)}`));
    for (;;) {
        const choice = await selectKey(`  Proxy started?`, [
            { key: "r", desc: "etry (re-attempt auto-start + kill stale)" },
            { key: "c", desc: "ancel" },
        ]);
        if (choice === "r") {
            if (await ensureCursorProxyRunning(PROXY_DEFAULT_URL, { forceRestart: true })) {
                console.log(chalk.green("\n  ✓ Proxy is running and healthy"));
                return true;
            }
            console.log(chalk.yellow(`  Still not reachable at ${PROXY_DEFAULT_URL}`));
        }
        else {
            return false;
        }
    }
}
/**
 * Build the full list of cursor model picker items. Priority models go first,
 * then known models, then any extra live models we fetched. If there are more
 * than a handful extras, they get a "more..." sub-menu.
 */
async function buildCursorPicker() {
    const liveIds = await fetchLiveCursorModels();
    const extra = new Set();
    for (const id of liveIds) {
        if (!KNOWN_CURSOR_MODEL_IDS.has(id))
            extra.add(id);
    }
    const top = [
        ...CURSOR_PRIORITY_MODELS.map(m => ({ id: m.id, name: m.label, hint: m.hint })),
        ...CURSOR_KNOWN_MODELS.map(m => ({ id: m.id, name: m.label, hint: m.hint })),
    ];
    // Only a few extras? show them inline. Otherwise defer to "more...".
    const MORE_THRESHOLD = 6;
    const more = [...extra].sort().map(id => ({
        id,
        name: id,
        hint: cursorModelHint(id),
    }));
    if (more.length <= MORE_THRESHOLD) {
        return { top: [...top, ...more], more: [] };
    }
    return { top, more };
}
async function pickCursorModel() {
    console.log(chalk.dim("\n  Cursor API Proxy Models"));
    console.log(chalk.dim("  " + "─".repeat(40)));
    // Quick health check with spinner
    let frame = 0;
    const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const spinner = setInterval(() => {
        process.stdout.write(`\x1B[2K\r  ${chalk.cyan(BRAILLE[frame++ % BRAILLE.length])} ${chalk.dim("checking proxy...")}`);
    }, 120);
    const healthy = await healthCheckCursorProxy();
    clearInterval(spinner);
    process.stdout.write("\x1B[2K\r");
    if (!healthy) {
        // Try to auto-start the proxy (auto-kills stale processes)
        const autoStarted = await ensureCursorProxyRunning();
        if (autoStarted) {
            // Proxy is up now — proceed to model list
        }
        else {
            console.log(chalk.yellow("  Proxy is not running at " + PROXY_DEFAULT_URL));
            for (;;) {
                const choice = await selectKey(`  How to proceed?`, [
                    { key: "r", desc: "etry (re-attempt auto-start + kill stale)" },
                    { key: "i", desc: "nstall + configure (CLI, API key, server)" },
                    { key: "c", desc: "ancel" },
                ]);
                if (choice === "r") {
                    if (await ensureCursorProxyRunning(PROXY_DEFAULT_URL, { forceRestart: true })) {
                        console.log(chalk.green("  ✓ Proxy started"));
                        break;
                    }
                    console.log(chalk.yellow(`  Still not reachable at ${PROXY_DEFAULT_URL}`));
                }
                else if (choice === "i") {
                    const ok = await setupCursorProxy();
                    if (!ok)
                        return null;
                    if (await healthCheckCursorProxy())
                        break;
                    return null;
                }
                else {
                    return null;
                }
            }
        }
    }
    const { top, more } = await buildCursorPicker();
    // If there are more models available, add a "more…" entry
    const items = top.map(m => ({
        name: m.name,
        value: m.id,
        hint: m.hint,
    }));
    let hasMore = more.length > 0;
    if (hasMore) {
        items.push({ name: chalk.gray("more…"), value: "__more__", hint: `${more.length} additional models` });
    }
    const picked = await select("  Select a Cursor model:", items, 0);
    // Handle "more…" sub-menu
    if (picked === "__more__") {
        const moreItems = more.map(m => ({ name: m.name, value: m.id, hint: m.hint }));
        const morePicked = await select("  More Cursor models:", moreItems, 0);
        return saveCursorPick(morePicked);
    }
    return saveCursorPick(picked);
}
function saveCursorPick(modelId) {
    const existingKey = loadProviders().find(p => p.id === CURSOR_KEY_PROVIDER_ID)?.cursorApiKey;
    const provider = {
        id: `cursor-${modelId}`,
        displayName: `Cursor: ${modelId}`,
        baseURL: PROXY_DEFAULT_URL,
        model: modelId,
        cursorProxy: true,
        ...(existingKey ? { cursorApiKey: existingKey } : {}),
    };
    saveProvider(provider);
    console.log(chalk.green(`  ✓ Saved as provider: ${provider.displayName}`));
    return { model: modelId, providerId: provider.id, provider };
}
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
