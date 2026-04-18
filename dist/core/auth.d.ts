/** JWT token payload for claude-overnight providers. */
export interface JWTPayload {
    sub: string;
    model: string;
    bearer: string;
    aud: string;
    iat: number;
    exp: number;
}
/** A signed JWT token paired with its decoded payload. */
export interface TokenRecord {
    signedToken: string;
    payload: JWTPayload;
}
/**
 * Load the HMAC signing secret from disk, or generate a new 32-byte one.
 * Secrets are persisted to ~/.claude/claude-overnight/jwt-secret.key (mode 0600).
 */
export declare function loadSecret(): Buffer;
/**
 * Sign a new JWT token for a provider.
 * Tokens are HS256-signed with a per-provider derived key.
 */
export declare function signToken(providerId: string, model: string, bearer: string, baseURL: string): TokenRecord;
/**
 * Verify a JWT token and return its payload, or null if invalid/expired.
 */
export declare function verifyToken(token: string, providerId: string): JWTPayload | null;
/**
 * Get a signed JWT for a provider.
 * Returns a cached valid token if available, refreshes near-expiry ones,
 * or signs a fresh token.
 */
export declare function getBearerToken(providerId: string, model: string, bearer: string, baseURL: string): string;
/**
 * Manually refresh a token (e.g. from an external caller).
 * Only refreshes if the token is within 60s of expiry.
 */
export declare function refreshToken(oldToken: string, providerId: string): TokenRecord | null;
/**
 * Detect whether an error is related to JWT token authentication
 * (expiry, signature, invalid format) or general HTTP auth failure.
 */
export declare function isJWTAuthError(err: unknown): boolean;
export { clearTokenCache } from "./token-cache.js";
