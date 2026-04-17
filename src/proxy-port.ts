import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const CONFIG_FILE = "config.json";

/** Resolve proxy port (reads from config, or allocates and persists a new one). */
export function getProxyPort(projectRoot: string): number {
  const dir = join(projectRoot, ".claude-overnight");
  const file = join(dir, CONFIG_FILE);
  try {
    const cfg = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof cfg.proxyPort === "number" && cfg.proxyPort >= 1024 && cfg.proxyPort <= 65535) {
      return cfg.proxyPort;
    }
  } catch { /* not found or malformed */ }

  const port = 61000 + Math.floor(Math.random() * 4536);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : {};
    writeFileSync(file, JSON.stringify({ ...existing, proxyPort: port }, null, 2));
  } catch { /* best effort */ }
  return port;
}

/** Build the full proxy URL for a per-project port. */
export function buildProxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
