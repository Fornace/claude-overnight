/**
 * High-level JWT token lifecycle management.
 *
 * This is the canonical home for token get/refresh/verify/revoke/error-detection.
 * Re-exported by `auth.ts` as part of the unified public API.
 *
 * Dependencies are kept narrow — only key-vault, token-cache, and jwt-signer —
 * to avoid circular imports with auth.ts.
 */
import { storeKey } from "./key-vault.js";
import { signToken, resignToken, verifyTokenWithResult } from "./jwt-signer.js";
import { getCachedToken, peekCachedToken, cacheToken, revokeSession, clearTokenCache, tryRefreshCachedToken, } from "./token-cache.js";
// ── Token lifecycle ──
/**
 * Get a signed JWT for a provider.
 *
 * Flow: store key in vault → check cache → refresh near-expiry → sign fresh.
 * The raw API key is persisted in the key vault, never embedded in the token.
 * The returned JWT carries a session ID for revocation support.
 */
export function getBearerToken(providerId, model, bearer, baseURL) {
    storeKey(providerId, bearer);
    const cached = getCachedToken(providerId);
    if (cached)
        return cached.signedToken;
    const refreshed = tryRefreshCachedToken(providerId, resignToken);
    if (refreshed)
        return refreshed.signedToken;
    const fresh = signToken(providerId, model, bearer, baseURL);
    if (fresh) {
        cacheToken(providerId, {
            signedToken: fresh.token,
            payload: fresh.payload,
            sessionId: fresh.sessionId,
        });
    }
    return fresh?.token ?? bearer;
}
/**
 * Manually refresh a token. Only succeeds if the token is within 60s of expiry.
 * Useful when an external caller detects an imminent expiration.
 */
export function refreshToken(oldToken, providerId) {
    const result = verifyTokenWithResult(oldToken, { providerId });
    if (!result.valid || !result.payload)
        return null;
    // Only refresh if the token is within 60s of expiry
    const now = Math.floor(Date.now() / 1000);
    if (result.payload.exp - now > 60)
        return null;
    const refreshed = resignToken(result.payload);
    if (!refreshed)
        return null;
    const record = {
        signedToken: refreshed.token,
        payload: refreshed.payload,
        sessionId: refreshed.payload.jti,
    };
    cacheToken(providerId, record);
    return record;
}
/**
 * Verify a JWT bearer token and return its payload if valid.
 * Checks cryptographic validity, token version, claim matching, and revocation status.
 */
export function verifyBearerToken(token, providerId) {
    const result = verifyTokenWithResult(token, { providerId });
    if (!result.valid)
        return result;
    // Reject if the session was explicitly revoked
    const cached = getCachedToken(providerId);
    if (cached && result.payload && cached.sessionId !== result.payload.jti) {
        return { valid: false, reason: "revoked" };
    }
    return result;
}
/**
 * Revoke all tokens for a provider.
 * Clears cached tokens and marks their sessions as revoked.
 */
export function revokeProvider(providerId) {
    const cached = getCachedToken(providerId);
    if (cached)
        revokeSession(cached.sessionId);
    const peeked = tryPeekAndRevoke(providerId);
    if (!peeked)
        clearTokenCache();
}
function tryPeekAndRevoke(providerId) {
    const entry = peekCachedToken(providerId);
    if (entry) {
        revokeSession(entry.sessionId);
        return true;
    }
    return false;
}
/**
 * Detect whether an error is related to JWT authentication failure.
 *
 * Checks for JWT-specific error indicators rather than generic HTTP status codes,
 * reducing false positives from unrelated 401/403 responses.
 */
export function isJWTAuthError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    // JWT-specific indicators (high confidence)
    const jwtIndicators = [
        "token expired", "invalid_token", "jwt", "signature",
        "invalid_api_key", "authentication",
    ];
    for (const indicator of jwtIndicators) {
        if (lower.includes(indicator))
            return true;
    }
    // Generic HTTP auth errors — only match if the message also mentions
    // API/token context to reduce false positives from unrelated 401/403
    const genericAuth = ["unauthorized", "forbidden"];
    const hasContext = lower.includes("anthropic") || lower.includes("api")
        || lower.includes("bearer") || lower.includes("key") || lower.includes("token");
    for (const indicator of genericAuth) {
        if (lower.includes(indicator) && hasContext)
            return true;
    }
    return false;
}
