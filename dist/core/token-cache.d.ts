import type { TokenRecord, JWTPayload } from "./auth.js";
/**
 * Return a cached token record if it exists and has not expired.
 * The payload is NOT re-verified — trust the cache entry's payload.
 */
export declare function getCachedToken(providerId: string): TokenRecord | null;
/** Store a fresh token record in the cache. */
export declare function cacheToken(providerId: string, record: TokenRecord): void;
/**
 * Try to refresh a cached token before it expires.
 * Returns a new record if the existing one is within 60s of expiry,
 * otherwise returns null (no cached entry or still has plenty of time).
 * The caller must pass a signer function to create the replacement.
 */
export declare function tryRefreshCachedToken(providerId: string, signer: (payload: JWTPayload) => string): TokenRecord | null;
/** Remove all cached tokens — called when providers are updated. */
export declare function clearTokenCache(): void;
