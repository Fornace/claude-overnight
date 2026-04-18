import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getBearerToken, refreshToken, verifyBearerToken,
  revokeProvider, isJWTAuthError,
} from "../core/token-manager.js";
import { resetSecretCache } from "../core/secret-manager.js";
import { clearTokenCache, clearRevocations } from "../core/token-cache.js";

const TEST_PROVIDER = "test-provider";
const TEST_MODEL = "test-model";
const TEST_BASE = "https://api.example.com";
const TEST_KEY = "sk-test-key-abcdef";

function setup() {
  resetSecretCache();
  clearTokenCache();
  clearRevocations();
}

describe("token-manager: getBearerToken", () => {
  beforeEach(setup);

  it("returns a signed JWT token", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(typeof token === "string");
    assert.ok(token.length > 0);
    // JWT has three dot-separated segments
    assert.ok(token.split(".").length === 3, "JWT should have 3 parts");
  });

  it("returns same token on second call (cache hit)", () => {
    const t1 = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    const t2 = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.equal(t1, t2, "second call should return cached token");
  });

  it("falls back to raw key when signing fails", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, "", TEST_BASE);
    assert.equal(token, "", "empty key should fall through to empty bearer");
  });
});

describe("token-manager: refreshToken", () => {
  beforeEach(setup);

  it("refreshes a valid token", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    // Token is fresh, so it has ~300s remaining (> 60s threshold)
    // refreshToken only works within 60s of expiry
    const result = refreshToken(token, TEST_PROVIDER);
    assert.equal(result, null, "fresh token should not be refreshed");
  });

  it("rejects invalid token", () => {
    const result = refreshToken("invalid.token.here", TEST_PROVIDER);
    assert.equal(result, null);
  });

  it("rejects token from wrong provider", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    const result = refreshToken(token, "wrong-provider");
    assert.equal(result, null);
  });
});

describe("token-manager: verifyBearerToken", () => {
  beforeEach(setup);

  it("verifies a valid token", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    const result = verifyBearerToken(token, TEST_PROVIDER);
    assert.equal(result.valid, true);
    assert.ok(result.payload);
  });

  it("rejects invalid token", () => {
    const result = verifyBearerToken("bad.token", TEST_PROVIDER);
    assert.equal(result.valid, false);
  });

  it("rejects token from wrong provider", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    const result = verifyBearerToken(token, "other-provider");
    assert.equal(result.valid, false);
  });

  it("rejects revoked token", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    revokeProvider(TEST_PROVIDER);
    const result = verifyBearerToken(token, TEST_PROVIDER);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "revoked");
  });
});

describe("token-manager: revokeProvider", () => {
  beforeEach(setup);

  it("revokes all tokens for a provider", () => {
    const token = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    revokeProvider(TEST_PROVIDER);
    const result = verifyBearerToken(token, TEST_PROVIDER);
    assert.equal(result.valid, false);
  });

  it("allows fresh token after revoke + re-issue", () => {
    getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    revokeProvider(TEST_PROVIDER);
    const newToken = getBearerToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    const result = verifyBearerToken(newToken, TEST_PROVIDER);
    assert.equal(result.valid, true);
  });
});

describe("token-manager: isJWTAuthError", () => {
  it("detects JWT-specific errors", () => {
    assert.equal(isJWTAuthError(new Error("token expired")), true);
    assert.equal(isJWTAuthError(new Error("invalid_token")), true);
    assert.equal(isJWTAuthError(new Error("JWT verification failed")), true);
    assert.equal(isJWTAuthError(new Error("signature mismatch")), true);
    assert.equal(isJWTAuthError(new Error("invalid_api_key")), true);
  });

  it("detects generic auth errors with API context", () => {
    assert.equal(isJWTAuthError(new Error("unauthorized: bad API key")), true);
    assert.equal(isJWTAuthError(new Error("Authentication failed for Anthropic")), true);
    assert.equal(isJWTAuthError(new Error("Bearer token is invalid")), true);
  });

  it("does NOT match generic HTTP errors without context", () => {
    assert.equal(isJWTAuthError(new Error("Forbidden")), false);
    assert.equal(isJWTAuthError(new Error("Unauthorized")), false);
  });

  it("handles non-Error inputs", () => {
    assert.equal(isJWTAuthError("token expired"), true);
    assert.equal(isJWTAuthError({ message: "jwt error" }), true);
    assert.equal(isJWTAuthError(401), false);
    assert.equal(isJWTAuthError(null), false);
    assert.equal(isJWTAuthError(undefined), false);
  });

  it("case insensitive matching", () => {
    assert.equal(isJWTAuthError(new Error("TOKEN EXPIRED")), true);
    assert.equal(isJWTAuthError(new Error("Invalid_Token")), true);
    assert.equal(isJWTAuthError(new Error("JWT")), true);
  });
});
