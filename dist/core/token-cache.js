/** In-memory cache of signed JWT tokens per provider. */
const tokenCache = new Map();
/**
 * Return a cached token record if it exists and has not expired.
 * The payload is NOT re-verified — trust the cache entry's payload.
 */
export function getCachedToken(providerId) {
    const entry = tokenCache.get(providerId);
    if (!entry)
        return null;
    const now = Math.floor(Date.now() / 1000);
    if (entry.payload.exp > now + 30)
        return entry;
    tokenCache.delete(providerId);
    return null;
}
/** Store a fresh token record in the cache. */
export function cacheToken(providerId, record) {
    tokenCache.set(providerId, record);
}
/**
 * Try to refresh a cached token before it expires.
 * Returns a new record if the existing one is within 60s of expiry,
 * otherwise returns null (no cached entry or still has plenty of time).
 * The caller must pass a signer function to create the replacement.
 */
export function tryRefreshCachedToken(providerId, signer) {
    const entry = tokenCache.get(providerId);
    if (!entry)
        return null;
    const now = Math.floor(Date.now() / 1000);
    if (entry.payload.exp - now <= 60) {
        const newToken = signer(entry.payload);
        const newRecord = { signedToken: newToken, payload: entry.payload };
        tokenCache.set(providerId, newRecord);
        return newRecord;
    }
    return null;
}
/** Remove all cached tokens — called when providers are updated. */
export function clearTokenCache() {
    tokenCache.clear();
}
