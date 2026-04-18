/**
 * In-memory cache for signed JWT tokens per provider.
 * Self-contained — no imports from auth.ts to avoid circular deps.
 */

/** Current token format version. Bumped to invalidate old tokens. */
export const TOKEN_VERSION = "v2";

/** JWT payload scoped to a single provider. */
export interface JWTPayload {
  sub: string;       // Provider id
  model: string;     // Model the token is scoped to
  aud: string;       // Endpoint base URL
  iat: number;       // Issued-at epoch seconds
  exp: number;       // Expiry epoch seconds
  jti: string;       // Session ID (replaces embedded `sk` key)
  ver: string;       // Token format version
}

/** A signed JWT paired with its decoded payload. */
export interface TokenRecord {
  signedToken: string;
  payload: JWTPayload;
  /** The session ID used for key vault lookup. */
  sessionId: string;
}

/** In-memory cache of signed JWT tokens per provider. */
const tokenCache = new Map<string, TokenRecord>();

/** Session IDs that have been explicitly revoked, with revocation timestamp. */
const revokedSessions = new Map<string, number>();

/** Max entries in the revocation set before automatic pruning. */
const MAX_REVOCATIONS = 500;

/** Revocation entries older than this are pruned (1 hour). */
const REVOCATION_TTL_SEC = 3600;

/**
 * Return a cached token record if it exists and has >=30s remaining.
 * Also rejects revoked sessions.
 * The payload is NOT re-verified — trust the cache entry.
 */
export function getCachedToken(providerId: string): TokenRecord | null {
  const entry = tokenCache.get(providerId);
  if (!entry) return null;
  if (isSessionRevoked(entry.sessionId)) {
    tokenCache.delete(providerId);
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (entry.payload.exp > now + 30) return entry;
  tokenCache.delete(providerId);
  return null;
}

/**
 * Return the raw cache entry without any expiry filtering.
 * Used by the signer for the refresh path (needs entries within 60s of expiry).
 */
export function peekCachedToken(providerId: string): TokenRecord | null {
  return tokenCache.get(providerId) ?? null;
}

/** Store a fresh token record in the cache. */
export function cacheToken(providerId: string, record: TokenRecord): void {
  tokenCache.set(providerId, record);
}

/**
 * Try to refresh a cached token before it expires.
 * Returns a new record if the existing one is within 60s of expiry,
 * otherwise null (no cached entry or plenty of time left).
 */
export function tryRefreshCachedToken(
  providerId: string,
  refresher: (payload: JWTPayload) => { token: string; payload: JWTPayload } | null,
): TokenRecord | null {
  const entry = tokenCache.get(providerId);
  if (!entry) return null;
  if (isSessionRevoked(entry.sessionId)) {
    tokenCache.delete(providerId);
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (entry.payload.exp - now > 60) return null;
  const refreshed = refresher(entry.payload);
  if (!refreshed) return null;
  const record: TokenRecord = {
    signedToken: refreshed.token,
    payload: refreshed.payload,
    sessionId: refreshed.payload.jti,
  };
  tokenCache.set(providerId, record);
  return record;
}

/** Remove all cached tokens — called when providers are updated. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Revoke a token session by its ID.
 * The token will be rejected on next use even if still cryptographically valid. */
export function revokeSession(sessionId: string): void {
  revokedSessions.set(sessionId, Math.floor(Date.now() / 1000));
  // Also evict from cache if present
  for (const [k, v] of tokenCache) {
    if (v.sessionId === sessionId) { tokenCache.delete(k); break; }
  }
  pruneRevocations();
}

/** Check if a session ID has been revoked, pruning expired entries first. */
export function isSessionRevoked(sessionId: string): boolean {
  pruneRevocations();
  return revokedSessions.has(sessionId);
}

/** Clear the revocation set (e.g. on full reset). */
export function clearRevocations(): void {
  revokedSessions.clear();
}

/** Get the number of revoked sessions (for diagnostics). */
export function getRevocationCount(): number {
  return revokedSessions.size;
}

/** Check if a session ID has been revoked, pruning expired entries first. */
export function isSessionRevoked(sessionId: string): boolean {
  pruneRevocations();
  return revokedSessions.has(sessionId);
}

/** Remove expired revocation entries and enforce max size. */
function pruneRevocations(): void {
  if (revokedSessions.size === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - REVOCATION_TTL_SEC;

  // Remove entries older than the TTL
  for (const [id, ts] of revokedSessions) {
    if (ts < cutoff) revokedSessions.delete(id);
  }

  // If still over the limit, remove the oldest entries
  if (revokedSessions.size > MAX_REVOCATIONS) {
    const sorted = [...revokedSessions.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, sorted.length - MAX_REVOCATIONS);
    for (const [id] of toRemove) revokedSessions.delete(id);
  }
}
