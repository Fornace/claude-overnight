/**
 * Authentication module — JWT-based token management.
 *
 * Architecture:
 *   secret-manager  → HMAC secret loading + per-provider key derivation
 *   jwt-signer      → HS256 JWT sign/verify/resign (no embedded keys)
 *   token-cache     → In-memory token cache with revocation support
 *   token-manager   → High-level lifecycle (get, refresh, verify, revoke)
 *   key-vault       → File-based raw key storage
 *
 * Flow: raw API key → stored in key vault → JWT issued with session ID
 *   → raw key never embedded in token → revocation via session ID
 *
 * This is the unified public API. All consumers should import from here.
 */
export { loadSecret, deriveKey, resetSecretCache } from "./secret-manager.js";
export {
  signToken, resignToken, verifyToken, verifyTokenWithResult,
  DEFAULT_TTL_SEC,
  type VerifyResult,
  type VerifyOptions,
} from "./jwt-signer.js";
export {
  clearTokenCache,
  revokeSession,
  clearRevocations,
  getRevocationCount,
  TOKEN_VERSION,
  type TokenRecord,
  type JWTPayload,
} from "./token-cache.js";
export {
  getBearerToken,
  refreshToken,
  verifyBearerToken,
  revokeProvider,
  isJWTAuthError,
} from "./token-manager.js";
export { storeKey, getKey, deleteKey, clearVault } from "./key-vault.js";
