// Cursor proxy: env, paths, token/key resolution, account pool, log tails, model fetch.
// Low-level utilities with no dependency on the proxy lifecycle.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, openSync, statSync, readSync, closeSync } from "fs";
import { createRequire } from "node:module";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "node:url";
import { execSync } from "child_process";
import chalk from "chalk";
import { loadProviders } from "./index.js";
export const PROXY_DEFAULT_URL = "http://127.0.0.1:8765";
/** Cached system Node.js and agent script paths — resolved once, reused across envFor calls. */
let _cachedAgentNode = null;
let _cachedAgentScript = null;
/** Resolve system Node.js and agent index.js paths. Returns [nodePath, scriptPath] or [null, null]. */
export function resolveAgentPaths(timeoutMs = 2_000) {
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
/** Cache the resolved paths for use inside envFor. */
export function cachedAgentPaths() {
    if (!_cachedAgentNode || !_cachedAgentScript) {
        const [node, script] = resolveAgentPaths(2_000);
        _cachedAgentNode = node;
        _cachedAgentScript = script;
    }
    return [_cachedAgentNode, _cachedAgentScript];
}
/** Run the installed package CLI with `node` (avoids npx/npm invoking extra tooling on macOS). */
export function resolveCursorComposerCli() {
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
export function getEmbeddedComposerProxyVersion() {
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
export function getClaudeOvernightInstallRoot() {
    return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}
/** Shell command to run the same bundled proxy CLI we spawn in-process (never `npx`/global). */
export function bundledComposerProxyShellCommand() {
    const cli = resolveCursorComposerCli();
    if (!cli)
        return null;
    return `node "${cli}"`;
}
/** Check if a provider routes through cursor-composer-in-claude. */
export function isCursorProxyProvider(p) {
    return p.cursorProxy === true || p.baseURL === PROXY_DEFAULT_URL;
}
// ── Log tails ──
function cursorProxyLogDir() {
    return join(homedir(), ".cursor-api-proxy");
}
export function cursorProxyOutLogPath() {
    return join(cursorProxyLogDir(), "proxy.out.log");
}
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
/** Read the tail of both proxy logs for diagnostics. */
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
// ── Token resolution ──
/** Resolve the cursor-composer-in-claude API key from env or providers.json. */
export function resolveCursorProxyKey() {
    if (process.env.CURSOR_BRIDGE_API_KEY?.trim())
        return process.env.CURSOR_BRIDGE_API_KEY.trim();
    const saved = loadProviders().find(p => p.cursorProxy);
    if (saved?.cursorApiKey?.trim())
        return saved.cursorApiKey.trim();
    return null;
}
/**
 * Token for the native Cursor `agent` binary — same order as cursor-composer `loadBridgeConfig`
 * (CURSOR_API_KEY → CURSOR_AUTH_TOKEN → bridge / stored).
 */
export function resolveCursorAgentToken() {
    if (process.env.CURSOR_API_KEY?.trim())
        return process.env.CURSOR_API_KEY.trim();
    if (process.env.CURSOR_AUTH_TOKEN?.trim())
        return process.env.CURSOR_AUTH_TOKEN.trim();
    return resolveCursorProxyKey();
}
export function hasCursorAgentToken() {
    return resolveCursorAgentToken() != null;
}
/** Resolved token for tests/diagnostics (never log the return value). */
export function getCursorAgentToken() {
    return resolveCursorAgentToken();
}
/** Build fetch options with the cursor proxy auth header if a key is available. */
export function cursorProxyFetchOpts() {
    const key = resolveCursorProxyKey();
    return key ? { headers: { Authorization: `Bearer ${key}` } } : {};
}
// ── Account pool (parallel cursor-agent isolation) ──
/**
 * Ensure an "account pool" of cloned config dirs exists under
 * `~/.cursor-api-proxy/accounts/pool-{1..N}`. Each clone is a copy of the
 * user's `~/.cursor/cli-config.json`. Gives each spawned agent its own
 * CURSOR_CONFIG_DIR so parallel cli-config.json writes don't race.
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
// ── macOS zsh patch detection ──
/** True if ~/.zshrc / ~/.zprofile contain the `run_cursor_agent` workaround. */
export function hasCursorMacAgentZshPatch() {
    let combined = "";
    for (const f of [".zshrc", ".zprofile"]) {
        try {
            combined += readFileSync(join(homedir(), f), "utf8");
        }
        catch { /* missing */ }
    }
    return /run_cursor_agent\s*\(/.test(combined) || /alias\s+agent=\s*['"]?run_cursor_agent['"]?/.test(combined);
}
let warnedMacCursorAgentPatch = false;
/** On macOS, warn once if the Cursor agent CLI is installed but the zsh workaround is missing. */
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
// ── Model list fetches ──
/** Fetch available Cursor models via GET /v1/models on the proxy. */
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
 * Try to fetch live Cursor model IDs. Falls back to empty array — the caller
 * merges with known constants.
 *
 * NOTE: `agent --list-models` segfaults with its bundled Node.js binary
 * (exit 139). Run with system `node` instead.
 */
export async function fetchLiveCursorModels() {
    const proxyModels = await fetchCursorModels();
    if (proxyModels.length > 0)
        return proxyModels;
    try {
        const agentPath = execSync("command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null", {
            timeout: 3_000, encoding: "utf-8", shell: "bash",
        }).trim();
        if (!agentPath)
            return [];
        const dir = dirname(realpathSync(agentPath));
        const indexPath = `${dir}/index.js`;
        const raw = execSync(`node "${indexPath}" --list-models 2>/dev/null`, {
            timeout: 10_000, encoding: "utf-8",
        });
        const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
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
