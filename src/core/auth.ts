import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes, createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { clearTokenCache, getCachedToken, cacheToken, tryRefreshCachedToken } from "./token-cache.js";

// ── Types ──

/** JWT token payload for claude-overnight providers. */
export interface JWTPayload {
  sub: string;       // Provider id
  model: string;     // Model the token is scoped to
  bearer: string;    // Underlying API key
  aud: string;       // Endpoint base URL
  iat: number;       // Issued-at epoch seconds
  exp: number;       // Expiry epoch seconds
}

/** A signed JWT token paired with its decoded payload. */
export interface TokenRecord {
  signedToken: string;
  payload: JWTPayload;
}

// ── Secret management ──

const SECRET_PATH = join(homedir(), ".claude", "claude-overnight", "jwt-secret.key");
const DEFAULT_TTL_SEC = 300; // 5 minutes

/**
 * Load the HMAC signing secret from disk, or generate a new 32-byte one.
 * Secrets are persisted to ~/.claude/claude-overnight/jwt-secret.key (mode 0600).
 */
export function loadSecret(): Buffer {
  try {
    const raw = readFileSync(SECRET_PATH);
    if (raw.length >= 32) return raw;
  } catch {}
  const secret = randomBytes(32);
  mkdirSync(join(homedir(), ".claude", "claude-overnight"), { recursive: true });
  writeFileSync(SECRET_PATH, secret);
  try { chmodSync(SECRET_PATH, 0o600); } catch {}
  return secret;
}

/** Derive a per-provider HMAC key from the master secret. */
function deriveKey(secret: Buffer, providerId: string): Buffer {
  return createHmac("sha256", secret).update(providerId).digest();
}

// ── Signing ──

/**
 * Sign a new JWT token for a provider.
 * Tokens are HS256-signed with a per-provider derived key.
 */
export function signToken(providerId: string, model: string, bearer: string, baseURL: string): TokenRecord {
  const secret = loadSecret();
  const key = deriveKey(secret, providerId);
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: providerId,
    model,
    bearer,
    aud: baseURL,
    iat: now,
    exp: now + DEFAULT_TTL_SEC,
  };
  const signedToken = jwt.sign(payload, key, { algorithm: "HS256" });
  return { signedToken, payload };
}

/**
 * Sign a fresh token from an existing payload — used for refresh
 * without re-exposing the raw bearer key.
 */
function signFromPayload(payload: JWTPayload): string {
  const secret = loadSecret();
  const key = deriveKey(secret, payload.sub);
  const now = Math.floor(Date.now() / 1000);
  const refreshed: JWTPayload = { ...payload, iat: now, exp: now + DEFAULT_TTL_SEC };
  return jwt.sign(refreshed, key, { algorithm: "HS256" });
}

// ── Verification ──

/**
 * Verify a JWT token and return its payload, or null if invalid/expired.
 */
export function verifyToken(token: string, providerId: string): JWTPayload | null {
  const secret = loadSecret();
  const key = deriveKey(secret, providerId);
  try {
    return jwt.verify(token, key, { algorithms: ["HS256"] }) as JWTPayload;
  } catch {
    return null;
  }
}

// ── High-level API ──

/**
 * Get a signed JWT for a provider.
 * Returns a cached valid token if available, refreshes near-expiry ones,
 * or signs a fresh token.
 */
export function getBearerToken(providerId: string, model: string, bearer: string, baseURL: string): string {
  // Cache hit — token is valid with >=30s remaining, no re-verify needed.
  const cached = getCachedToken(providerId);
  if (cached) return cached.signedToken;

  // Near-expiry refresh without re-passing the raw key.
  const refreshed = tryRefreshCachedToken(providerId, signFromPayload);
  if (refreshed) return refreshed.signedToken;

  // First use or stale cache — sign a fresh token.
  const fresh = signToken(providerId, model, bearer, baseURL);
  cacheToken(providerId, fresh);
  return fresh.signedToken;
}

/**
 * Manually refresh a token (e.g. from an external caller).
 * Only refreshes if the token is within 60s of expiry.
 */
export function refreshToken(oldToken: string, providerId: string): TokenRecord | null {
  const payload = verifyToken(oldToken, providerId);
  if (!payload) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp - now > 60) return null;
  const newToken = signFromPayload(payload);
  const record: TokenRecord = { signedToken: newToken, payload };
  cacheToken(providerId, record);
  return record;
}

// ── Error classification ──

/**
 * Detect whether an error is related to JWT token authentication
 * (expiry, signature, invalid format) or general HTTP auth failure.
 */
export function isJWTAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes("token expired") || lower.includes("invalid_token")
    || lower.includes("jwt") || lower.includes("signature")
    || lower.includes("unauthorized") || lower.includes("forbidden")
    || lower.includes("invalid_api_key") || lower.includes("authentication");
}

// ── Re-export cache API for callers that import from auth.js ──
export { clearTokenCache } from "./token-cache.js";
