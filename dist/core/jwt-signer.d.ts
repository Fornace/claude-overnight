import { type JWTPayload } from "./token-cache.js";
export declare const DEFAULT_TTL_SEC = 300;
/** Detailed result of JWT verification. */
export interface VerifyResult {
    valid: boolean;
    payload?: JWTPayload;
    /** Reason why verification failed, if applicable. */
    reason?: "expired" | "invalid_signature" | "wrong_version" | "claim_mismatch" | "revoked";
}
/** Expected claims to validate during verification. */
export interface VerifyOptions {
    /** Expected provider id (token `sub` claim). */
    providerId?: string;
    /** Expected model (token `model` claim). */
    model?: string;
    /** Expected endpoint base URL (token `aud` claim). */
    baseURL?: string;
}
/**
 * Sign a new JWT for a provider.
 *
 * The token embeds a `jti` (session ID) instead of the raw API key.
 * The raw key stays in the key vault and is looked up at verification time.
 */
export declare function signToken(providerId: string, model: string, bearer: string, baseURL: string): {
    token: string;
    payload: JWTPayload;
    sessionId: string;
} | null;
/**
 * Verify a JWT and return its decoded payload, or null if invalid/expired.
 *
 * This is a convenience wrapper around {@link verifyTokenWithResult} that
 * discards the reason. Use verifyTokenWithResult when you need to know
 * why verification failed.
 */
export declare function verifyToken(token: string, providerId: string): JWTPayload | null;
/**
 * Verify a JWT with optional claim validation.
 *
 * Checks:
 * 1. Cryptographic signature (HS256 with per-provider derived key)
 * 2. Token version compatibility
 * 3. Expiration
 * 4. Claim matching (sub, model, aud) when options are provided
 */
export declare function verifyTokenWithResult(token: string, options?: VerifyOptions): VerifyResult;
/**
 * Re-sign an existing payload with a fresh `iat`/`exp`.
 * Preserves the original session ID so revocation state is maintained.
 */
export declare function resignToken(payload: JWTPayload): {
    token: string;
    payload: JWTPayload;
} | null;
