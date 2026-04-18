import type { TokenRecord, JWTPayload } from "./auth.js";

/** In-memory cache of signed JWT tokens per provider. */
const tokenCache = new Map<string, TokenRecord>();

/**
 * Return a cached token record if it exists and has not expired.
 * The payload is NOT re-verified — trust the cache entry's payload.
 */
export function getCachedToken(providerId: string): TokenRecord | null {
  const entry = tokenCache.get(providerId);
  if (!entry) return null;
  const now = Math.floor(Date.now() / 1000);
  if (entry.payload.exp > now + 30) return entry;
  tokenCache.delete(providerId);
  return null;
}

/** Store a fresh token record in the cache. */
export function cacheToken(providerId: string, record: TokenRecord): void {
  tokenCache.set(providerId, record);
}

/**
 * Try to refresh a cached token before it expires.
 * Returns a new record if the existing one is within 60s of expiry,
 * otherwise returns null (no cached entry or still has plenty of time).
 * The caller must pass a signer function to create the replacement.
 */
export function tryRefreshCachedToken(
  providerId: string,
  signer: (payload: JWTPayload) => string,
): TokenRecord | null {
  const entry = tokenCache.get(providerId);
  if (!entry) return null;
  const now = Math.floor(Date.now() / 1000);
  if (entry.payload.exp - now <= 60) {
    const newToken = signer(entry.payload);
    const newRecord: TokenRecord = { signedToken: newToken, payload: entry.payload };
    tokenCache.set(providerId, newRecord);
    return newRecord;
  }
  return null;
}

/** Remove all cached tokens — called when providers are updated. */
export function clearTokenCache(): void {
  tokenCache.clear();
}
