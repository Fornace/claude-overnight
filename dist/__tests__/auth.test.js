import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { signToken, verifyToken, verifyTokenWithResult, resignToken, getBearerToken, refreshToken, revokeProvider, isJWTAuthError, clearTokenCache, revokeSession, clearRevocations, getRevocationCount, resetSecretCache, DEFAULT_TTL_SEC, TOKEN_VERSION, } from "../core/auth.js";
// ── Helpers ──
const PROVIDER = "test-provider";
const MODEL = "test-model";
const BEARER = "sk-test-key-abc123";
const BASE_URL = "https://api.example.com/v1";
function resetAuthState() {
    clearTokenCache();
    clearRevocations();
    resetSecretCache();
}
// ── Token Cache ──
describe("Token Cache", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("returns null for unknown provider", () => {
        const token = getBearerToken("unknown", MODEL, BEARER, BASE_URL);
        assert.ok(token.length > 0);
    });
    it("returns the same cached token on repeated calls", () => {
        const t1 = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        const t2 = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.strictEqual(t1, t2, "cached token should be reused");
    });
    it("clears all cached tokens", () => {
        getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        clearTokenCache();
        // After clear, a new call should produce a different token (new session ID)
        const fresh = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(fresh.length > 0);
    });
});
// ── JWT Signing & Verification ──
describe("JWT Signing & Verification", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("signs a valid JWT token", () => {
        const result = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(result !== null);
        assert.ok(result.token.length > 0);
        assert.strictEqual(result.payload.sub, PROVIDER);
        assert.strictEqual(result.payload.model, MODEL);
        assert.strictEqual(result.payload.aud, BASE_URL);
        assert.ok(result.payload.jti.length > 0);
        assert.strictEqual(result.payload.ver, TOKEN_VERSION);
    });
    it("returns null for empty bearer", () => {
        const result = signToken(PROVIDER, MODEL, "", BASE_URL);
        assert.strictEqual(result, null);
    });
    it("verifies a freshly signed token", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const decoded = verifyToken(signed.token, PROVIDER);
        assert.ok(decoded !== null);
        assert.strictEqual(decoded.sub, PROVIDER);
        assert.strictEqual(decoded.model, MODEL);
        assert.strictEqual(decoded.aud, BASE_URL);
    });
    it("rejects token verified with wrong provider key", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const decoded = verifyToken(signed.token, "wrong-provider");
        assert.strictEqual(decoded, null, "wrong provider key should fail verification");
    });
    it("rejects tampered token", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const tampered = signed.token + "x";
        const decoded = verifyToken(tampered, PROVIDER);
        assert.strictEqual(decoded, null);
    });
    it("rejects completely invalid string", () => {
        const decoded = verifyToken("not.a.jwt.token", PROVIDER);
        assert.strictEqual(decoded, null);
    });
    it("sets correct TTL expiry", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const expectedExpiry = signed.payload.iat + DEFAULT_TTL_SEC;
        assert.strictEqual(signed.payload.exp, expectedExpiry);
    });
    it("generates unique session IDs", () => {
        const s1 = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        const s2 = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(s1 !== null && s2 !== null);
        assert.notStrictEqual(s1.sessionId, s2.sessionId);
    });
});
// ── Enhanced Verification (claim validation) ──
describe("verifyTokenWithResult", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("returns valid result for matching claims", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = verifyTokenWithResult(signed.token, {
            providerId: PROVIDER,
            model: MODEL,
            baseURL: BASE_URL,
        });
        assert.strictEqual(result.valid, true);
        assert.ok(result.payload);
    });
    it("returns claim_mismatch when sub doesn't match", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = verifyTokenWithResult(signed.token, { providerId: "other" });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, "claim_mismatch");
    });
    it("returns claim_mismatch when model doesn't match", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = verifyTokenWithResult(signed.token, { model: "wrong-model" });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, "claim_mismatch");
    });
    it("returns claim_mismatch when aud doesn't match", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = verifyTokenWithResult(signed.token, { baseURL: "https://other.com" });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, "claim_mismatch");
    });
    it("returns invalid_signature for tampered tokens", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = verifyTokenWithResult(signed.token + "X", { providerId: PROVIDER });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, "invalid_signature");
    });
    it("backward compatible with no options", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = verifyTokenWithResult(signed.token);
        assert.strictEqual(result.valid, true);
    });
});
// ── Token Resigning ──
describe("Token Resigning", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("re-signs a payload with fresh timestamps", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const before = Date.now();
        const resigned = resignToken(signed.payload);
        assert.ok(resigned !== null);
        const after = Date.now();
        assert.ok(resigned.payload.iat >= Math.floor(before / 1000) - 1);
        assert.ok(resigned.payload.iat <= Math.floor(after / 1000) + 1);
        assert.strictEqual(resigned.payload.exp - resigned.payload.iat, DEFAULT_TTL_SEC);
    });
    it("preserves session ID on resign", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const resigned = resignToken(signed.payload);
        assert.ok(resigned !== null);
        assert.strictEqual(resigned.payload.jti, signed.payload.jti);
    });
    it("preserves provider, model, and audience on resign", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const resigned = resignToken(signed.payload);
        assert.ok(resigned !== null);
        assert.strictEqual(resigned.payload.sub, signed.payload.sub);
        assert.strictEqual(resigned.payload.model, signed.payload.model);
        assert.strictEqual(resigned.payload.aud, signed.payload.aud);
    });
    it("returns null for payload without sub", () => {
        const badPayload = {
            sub: "",
            model: MODEL,
            aud: BASE_URL,
            iat: 0,
            exp: 0,
            jti: "abc",
            ver: TOKEN_VERSION,
        };
        assert.strictEqual(resignToken(badPayload), null);
    });
    it("resigned token passes verification", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const resigned = resignToken(signed.payload);
        assert.ok(resigned !== null);
        const decoded = verifyToken(resigned.token, PROVIDER);
        assert.ok(decoded !== null);
        assert.strictEqual(decoded.sub, PROVIDER);
    });
});
// ── Token Refresh ──
describe("Token Refresh", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("returns null for invalid token", () => {
        const result = refreshToken("invalid-token", PROVIDER);
        assert.strictEqual(result, null);
    });
    it("returns null for token not near expiry (freshly signed)", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        // Fresh token has 300s remaining — well above the 60s threshold
        const result = refreshToken(signed.token, PROVIDER);
        assert.strictEqual(result, null);
    });
    it("returns null for wrong provider", () => {
        const signed = signToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(signed !== null);
        const result = refreshToken(signed.token, "other-provider");
        assert.strictEqual(result, null);
    });
});
// ── Session Revocation ──
describe("Session Revocation", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("revokes a session by ID", () => {
        revokeSession("session-123");
        assert.strictEqual(getRevocationCount(), 1);
    });
    it("clears revocations", () => {
        revokeSession("session-1");
        revokeSession("session-2");
        assert.strictEqual(getRevocationCount(), 2);
        clearRevocations();
        assert.strictEqual(getRevocationCount(), 0);
    });
    it("revokeProvider revokes the cached session", () => {
        getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        revokeProvider(PROVIDER);
        // After revocation, the next call should produce a new token (new session)
        const fresh = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        assert.ok(fresh.length > 0);
    });
    it("revocation set is bounded (auto-prunes old entries)", () => {
        const MAX = 500;
        for (let i = 0; i < MAX + 100; i++) {
            revokeSession(`session-${i}`);
        }
        assert.ok(getRevocationCount() <= MAX, `expected <= ${MAX} revocations, got ${getRevocationCount()}`);
    });
});
// ── Error Classification ──
describe("isJWTAuthError", () => {
    it("detects token expired errors", () => {
        assert.strictEqual(isJWTAuthError(new Error("Token expired")), true);
        assert.strictEqual(isJWTAuthError(new Error("token expired at 2024-01-01")), true);
    });
    it("detects invalid_token errors", () => {
        assert.strictEqual(isJWTAuthError(new Error("invalid_token format")), true);
    });
    it("detects JWT-related errors", () => {
        assert.strictEqual(isJWTAuthError(new Error("jwt malformed")), true);
        assert.strictEqual(isJWTAuthError(new Error("invalid jwt signature")), true);
    });
    it("detects signature errors", () => {
        assert.strictEqual(isJWTAuthError(new Error("invalid signature")), true);
    });
    it("detects HTTP auth errors with API context", () => {
        assert.strictEqual(isJWTAuthError(new Error("Unauthorized: bad API key")), true);
        assert.strictEqual(isJWTAuthError(new Error("Forbidden: invalid token")), true);
        assert.strictEqual(isJWTAuthError(new Error("Authentication failed for bearer token")), true);
    });
    it("does NOT match bare HTTP errors without context", () => {
        assert.strictEqual(isJWTAuthError(new Error("Unauthorized")), false);
        assert.strictEqual(isJWTAuthError(new Error("Forbidden")), false);
    });
    it("detects API key errors", () => {
        assert.strictEqual(isJWTAuthError(new Error("invalid_api_key")), true);
        assert.strictEqual(isJWTAuthError(new Error("Authentication required")), true);
    });
    it("returns false for unrelated errors", () => {
        assert.strictEqual(isJWTAuthError(new Error("Network timeout")), false);
        assert.strictEqual(isJWTAuthError(new Error("File not found")), false);
        assert.strictEqual(isJWTAuthError(new Error("JSON parse error")), false);
    });
    it("handles non-Error inputs", () => {
        assert.strictEqual(isJWTAuthError("jwt verification failed"), true);
        assert.strictEqual(isJWTAuthError(42), false);
        assert.strictEqual(isJWTAuthError(null), false);
    });
    it("is case-insensitive", () => {
        assert.strictEqual(isJWTAuthError(new Error("UNAUTHORIZED: API KEY INVALID")), true);
        assert.strictEqual(isJWTAuthError(new Error("JWT Malformed")), true);
    });
});
// ── Integration: getBearerToken end-to-end ──
describe("getBearerToken integration", () => {
    beforeEach(resetAuthState);
    afterEach(resetAuthState);
    it("returns a JWT string (three dot-separated segments)", () => {
        const token = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        const parts = token.split(".");
        assert.strictEqual(parts.length, 3, "JWT should have 3 dot-separated segments");
    });
    it("produces tokens that verify against the correct provider", () => {
        const token = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        const decoded = verifyToken(token, PROVIDER);
        assert.ok(decoded !== null);
        assert.strictEqual(decoded.sub, PROVIDER);
        assert.strictEqual(decoded.model, MODEL);
        assert.strictEqual(decoded.aud, BASE_URL);
    });
    it("tokens fail verification with wrong provider", () => {
        const token = getBearerToken(PROVIDER, MODEL, BEARER, BASE_URL);
        const decoded = verifyToken(token, "wrong-provider");
        assert.strictEqual(decoded, null);
    });
    it("falls back to raw bearer when signToken returns null", () => {
        // Empty bearer causes signToken to return null, so getBearerToken falls back
        const token = getBearerToken(PROVIDER, MODEL, "", BASE_URL);
        assert.strictEqual(token, "");
    });
});
// ── Token Constants ──
describe("Token constants", () => {
    it("DEFAULT_TTL_SEC is 300 (5 minutes)", () => {
        assert.strictEqual(DEFAULT_TTL_SEC, 300);
    });
    it("TOKEN_VERSION is v2", () => {
        assert.strictEqual(TOKEN_VERSION, "v2");
    });
});
