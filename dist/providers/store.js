// Provider registry: types + persistence (~/.claude/claude-overnight/providers.json).
// Kept separate from env-building/picker so the store can be mocked in tests.
import { existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { clearTokenCache } from "../core/auth.js";
import { readJsonOrNull, writeJson } from "../core/fs-helpers.js";
const STORE_PATH = join(homedir(), ".claude", "claude-overnight", "providers.json");
export function getStorePath() { return STORE_PATH; }
export function loadProviders() {
    const parsed = readJsonOrNull(STORE_PATH);
    return Array.isArray(parsed?.providers) ? parsed.providers.filter(isValidProvider) : [];
}
export function saveProvider(p) {
    writeStore(loadProviders().filter(x => x.id !== p.id).concat(p));
}
export function deleteProvider(id) {
    if (!existsSync(STORE_PATH))
        return;
    writeStore(loadProviders().filter(x => x.id !== id));
}
function writeStore(providers) {
    writeJson(STORE_PATH, { providers });
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
