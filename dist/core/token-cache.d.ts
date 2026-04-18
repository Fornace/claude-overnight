/**
 * In-memory cache for signed JWT tokens per provider.
 * Self-contained — no imports from auth.ts to avoid circular deps.
 */
/** Current token format version. Bumped to invalidate old tokens. */
export declare const TOKEN_VERSION = "v2";
/** JWT payload scoped to a single provider. */
export interface JWTPayload {
    sub: string;
    model: string;
    aud: string;
    iat: number;
    exp: number;
    jti: string;
    ver: string;
}
/** A signed JWT paired with its decoded payload. */
export interface TokenRecord {
    signedToken: string;
    payload: JWTPayload;
    /** The session ID used for key vault lookup. */
    sessionId: string;
}
/**
 * Return a cached token record if it exists and has >=30s remaining.
 * Also rejects revoked sessions.
 * The payload is NOT re-verified — trust the cache entry.
 */
export declare function getCachedToken(providerId: string): TokenRecord | null;
/**
 * Return the raw cache entry without any expiry filtering.
 * Used by the signer for the refresh path (needs entries within 60s of expiry).
 */
export declare function peekCachedToken(providerId: string): TokenRecord | null;
/** Store a fresh token record in the cache. */
export declare function cacheToken(providerId: string, record: TokenRecord): void;
/**
 * Try to refresh a cached token before it expires.
 * Returns a new record if the existing one is within 60s of expiry,
 * otherwise null (no cached entry or plenty of time left).
 */
export declare function tryRefreshCachedToken(providerId: string, refresher: (payload: JWTPayload) => {
    token: string;
    payload: JWTPayload;
} | null): TokenRecord | null;
/** Remove all cached tokens — called when providers are updated. */
export declare function clearTokenCache(): void;
/**
 * Revoke a token session by its ID.
 * The token will be rejected on next use even if still cryptographically valid.
 */
export declare function revokeSession(sessionId: string): void;
/** Clear the revocation set (e.g. on full reset). */
export declare function clearRevocations(): void;
/** Get the number of revoked sessions (for diagnostics). */
export declare function getRevocationCount(): number;
