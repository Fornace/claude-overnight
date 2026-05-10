import { join } from "path";
import { readJsonOrNull, writeJson } from "./fs-helpers.js";
const CONFIG_FILE = "config.json";
/** Resolve proxy port (reads from config, or allocates and persists a new one). */
export function getProxyPort(projectRoot) {
    const file = join(projectRoot, ".claude-overnight", CONFIG_FILE);
    const cfg = readJsonOrNull(file);
    if (cfg?.proxyPort && cfg.proxyPort >= 1024 && cfg.proxyPort <= 65535)
        return cfg.proxyPort;
    const port = 61000 + Math.floor(Math.random() * 4536);
    try {
        writeJson(file, { ...(cfg ?? {}), proxyPort: port });
    }
    catch { /* best effort */ }
    return port;
}
/** Build the full proxy URL for a per-project port. */
export function buildProxyUrl(port) {
    return `http://127.0.0.1:${port}`;
}
