/** Secure file-based store for raw API keys, indexed by provider ID. */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VAULT_PATH = join(homedir(), ".claude", "claude-overnight", "key-vault.json");

const store = new Map<string, string>();
let loaded = false;

/** Load the vault from disk if not already loaded. */
function ensureLoaded(): void {
  if (loaded) return;
  try {
    const raw = readFileSync(VAULT_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") store.set(k, v);
      }
    }
  } catch {}
  loaded = true;
}

/** Persist the vault to disk with restricted permissions. */
function flush(): void {
  mkdirSync(join(homedir(), ".claude", "claude-overnight"), { recursive: true });
  const obj: Record<string, string> = {};
  for (const [k, v] of store) obj[k] = v;
  writeFileSync(VAULT_PATH, JSON.stringify(obj), "utf-8");
  try { chmodSync(VAULT_PATH, 0o600); } catch {}
}

/**
 * Store a raw API key for a provider.
 * The key is kept in memory and persisted to disk (mode 0600).
 */
export function storeKey(providerId: string, key: string): void {
  ensureLoaded();
  store.set(providerId, key);
  flush();
}

/** Retrieve a raw API key by provider ID, or null if not found. */
export function getKey(providerId: string): string | null {
  ensureLoaded();
  return store.get(providerId) ?? null;
}

/** Remove a key from the vault. Returns true if it existed. */
export function deleteKey(providerId: string): boolean {
  ensureLoaded();
  const existed = store.delete(providerId);
  if (existed) flush();
  return existed;
}

/** Clear the entire vault (memory + disk). */
export function clearVault(): void {
  store.clear();
  flush();
}
