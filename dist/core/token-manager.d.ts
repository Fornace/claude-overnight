import { type VerifyResult } from "./jwt-signer.js";
import { type TokenRecord } from "./token-cache.js";
/**
 * Get a signed JWT for a provider.
 *
 * Flow: store key in vault → check cache → refresh near-expiry → sign fresh.
 * The raw API key is persisted in the key vault, never embedded in the token.
 * The returned JWT carries a session ID for revocation support.
 */
export declare function getBearerToken(providerId: string, model: string, bearer: string, baseURL: string): string;
/**
 * Manually refresh a token. Only succeeds if the token is within 60s of expiry.
 * Useful when an external caller detects an imminent expiration.
 */
export declare function refreshToken(oldToken: string, providerId: string): TokenRecord | null;
/**
 * Verify a JWT bearer token and return its payload if valid.
 * Checks cryptographic validity, token version, claim matching, and revocation status.
 */
export declare function verifyBearerToken(token: string, providerId: string): VerifyResult;
/**
 * Revoke all tokens for a provider.
 * Clears cached tokens and marks their sessions as revoked.
 */
export declare function revokeProvider(providerId: string): void;
/**
 * Detect whether an error is related to JWT authentication failure.
 *
 * Checks for JWT-specific error indicators rather than generic HTTP status codes,
 * reducing false positives from unrelated 401/403 responses.
 */
export declare function isJWTAuthError(err: unknown): boolean;
