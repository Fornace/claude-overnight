/**
 * HMAC signing secret management.
 *
 * Loads a 32-byte master secret from disk, or generates one on first use.
 * Persists to ~/.claude/claude-overnight/jwt-secret.key (mode 0600).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

const SECRET_PATH = join(homedir(), ".claude", "claude-overnight", "jwt-secret.key");

let _secret: Buffer | null = null;
const _keyCache = new Map<string, Buffer>();

/**
 * Load the HMAC signing secret from disk, or generate a new 32-byte one.
 */
export function loadSecret(): Buffer {
  if (_secret) return _secret;
  try {
    const raw = readFileSync(SECRET_PATH);
    if (raw.length >= 32) { _secret = raw; return _secret; }
  } catch {}
  const secret = randomBytes(32);
  mkdirSync(join(homedir(), ".claude", "claude-overnight"), { recursive: true });
  writeFileSync(SECRET_PATH, secret);
  try { chmodSync(SECRET_PATH, 0o600); } catch {}
  _secret = secret;
  return _secret;
}

/** Derive a per-provider HMAC key from the master secret (cached). */
export function deriveKey(providerId: string): Buffer {
  let key = _keyCache.get(providerId);
  if (key) return key;
  key = createHmac("sha256", loadSecret()).update(providerId).digest();
  _keyCache.set(providerId, key);
  return key;
}

/** Clear in-memory secret and key caches. */
export function resetSecretCache(): void {
  _secret = null;
  _keyCache.clear();
}
