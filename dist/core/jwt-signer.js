/**
 * JWT signing and verification.
 *
 * Issues short-lived HS256 tokens scoped to a provider + model + endpoint.
 * Tokens carry a session ID (not the raw key) for proper separation of concerns.
 */
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { deriveKey } from "./secret-manager.js";
import { TOKEN_VERSION } from "./token-cache.js";
export const DEFAULT_TTL_SEC = 300; // 5 minutes
/**
 * Sign a new JWT for a provider.
 *
 * The token embeds a `jti` (session ID) instead of the raw API key.
 * The raw key stays in the key vault and is looked up at verification time.
 */
export function signToken(providerId, model, bearer, baseURL) {
    if (!bearer)
        return null;
    const key = deriveKey(providerId);
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomBytes(16).toString("hex");
    const payload = {
        sub: providerId,
        model,
        aud: baseURL,
        iat: now,
        exp: now + DEFAULT_TTL_SEC,
        jti: sessionId,
        ver: TOKEN_VERSION,
    };
    const token = jwt.sign(payload, key, { algorithm: "HS256" });
    return { token, payload, sessionId };
}
/**
 * Verify a JWT and return its decoded payload, or null if invalid/expired.
 *
 * This is a convenience wrapper around {@link verifyTokenWithResult} that
 * discards the reason. Use verifyTokenWithResult when you need to know
 * why verification failed.
 */
export function verifyToken(token, providerId) {
    const result = verifyTokenWithResult(token, { providerId });
    return result.valid ? result.payload : null;
}
/**
 * Verify a JWT with optional claim validation.
 *
 * Checks:
 * 1. Cryptographic signature (HS256 with per-provider derived key from token's `sub`)
 * 2. Token version compatibility
 * 3. Expiration
 * 4. Claim matching (sub, model, aud) when options are provided
 *
 * The key is derived from the token's own `sub` claim (decoded without
 * verification), so providerId is not required. If `providerId` is given,
 * it is validated as a claim AFTER successful signature verification.
 */
export function verifyTokenWithResult(token, options = {}) {
    const { providerId, model, baseURL } = options;
    // Unsafely decode the token to extract the `sub` claim so we can derive
    // the correct signing key. This does NOT verify the signature yet.
    const raw = jwt.decode(token);
    if (!raw || typeof raw !== "object") {
        return { valid: false, reason: "invalid_signature" };
    }
    const sub = raw.sub;
    if (typeof sub !== "string" || !sub) {
        return { valid: false, reason: "invalid_signature" };
    }
    const key = deriveKey(sub);
    try {
        const decoded = jwt.verify(token, key, {
            algorithms: ["HS256"],
            // Let jwt.verify check expiration for us
        });
        // Reject tokens from older versions
        if (decoded.ver !== TOKEN_VERSION) {
            return { valid: false, reason: "wrong_version" };
        }
        // Validate claims if expected values are provided
        if (providerId && decoded.sub !== providerId) {
            return { valid: false, reason: "claim_mismatch" };
        }
        if (model && decoded.model !== model) {
            return { valid: false, reason: "claim_mismatch" };
        }
        if (baseURL && decoded.aud !== baseURL) {
            return { valid: false, reason: "claim_mismatch" };
        }
        return { valid: true, payload: decoded };
    }
    catch (err) {
        const msg = err?.message?.toLowerCase() ?? "";
        if (msg.includes("expired") || msg.includes("expir")) {
            return { valid: false, reason: "expired" };
        }
        return { valid: false, reason: "invalid_signature" };
    }
}
/**
 * Re-sign an existing payload with a fresh `iat`/`exp`.
 * Preserves the original session ID so revocation state is maintained.
 */
export function resignToken(payload) {
    if (!payload.sub)
        return null;
    const key = deriveKey(payload.sub);
    const now = Math.floor(Date.now() / 1000);
    const refreshed = {
        sub: payload.sub,
        model: payload.model,
        aud: payload.aud,
        iat: now,
        exp: now + DEFAULT_TTL_SEC,
        jti: payload.jti, // preserve session ID
        ver: TOKEN_VERSION,
    };
    const token = jwt.sign(refreshed, key, { algorithm: "HS256" });
    return { token, payload: refreshed };
}
