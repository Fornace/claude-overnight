// Provider registry: types + persistence (~/.claude/claude-overnight/providers.json).
// Kept separate from env-building/picker so the store can be mocked in tests.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { clearTokenCache } from "../core/auth.js";
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
    writeStore(loadProviders().filter(x => x.id !== p.id).concat(p));
}
export function deleteProvider(id) {
    if (!existsSync(STORE_PATH))
        return;
    writeStore(loadProviders().filter(x => x.id !== id));
}
function writeStore(providers) {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify({ providers }, null, 2), "utf-8");
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
