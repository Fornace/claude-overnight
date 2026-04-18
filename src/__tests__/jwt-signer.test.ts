import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  signToken, verifyToken, verifyTokenWithResult, resignToken,
  DEFAULT_TTL_SEC,
} from "../core/jwt-signer.js";
import { resetSecretCache } from "../core/secret-manager.js";
import { clearTokenCache, clearRevocations } from "../core/token-cache.js";

const TEST_PROVIDER = "test-provider";
const TEST_MODEL = "test-model";
const TEST_BASE = "https://api.example.com";
const TEST_KEY = "sk-test-12345";

function setup() {
  resetSecretCache();
  clearTokenCache();
  clearRevocations();
}

describe("jwt-signer: signToken", () => {
  beforeEach(setup);

  it("returns null for empty bearer", () => {
    assert.equal(signToken(TEST_PROVIDER, TEST_MODEL, "", TEST_BASE), null);
  });

  it("signs a valid JWT with correct payload", () => {
    const result = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(result, "signToken should return a result");
    assert.ok(result.token, "token should be a non-empty string");
    assert.equal(result.payload.sub, TEST_PROVIDER);
    assert.equal(result.payload.model, TEST_MODEL);
    assert.equal(result.payload.aud, TEST_BASE);
    assert.equal(result.payload.ver, "v2");
    assert.ok(result.sessionId, "session ID should be present");
    assert.ok(result.payload.jti, "jti should match session ID");
    assert.equal(result.payload.jti, result.sessionId);
  });

  it("token expires after DEFAULT_TTL_SEC", () => {
    const result = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(result);
    const expectedExp = result.payload.iat + DEFAULT_TTL_SEC;
    assert.equal(result.payload.exp, expectedExp);
  });

  it("generates unique session IDs per call", () => {
    const r1 = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    const r2 = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(r1 && r2);
    assert.notEqual(r1.sessionId, r2.sessionId);
  });
});

describe("jwt-signer: verifyToken", () => {
  beforeEach(setup);

  it("verifies a valid token", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const payload = verifyToken(signed.token, TEST_PROVIDER);
    assert.ok(payload);
    assert.equal(payload.sub, TEST_PROVIDER);
    assert.equal(payload.model, TEST_MODEL);
    assert.equal(payload.aud, TEST_BASE);
  });

  it("rejects token with wrong provider", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const payload = verifyToken(signed.token, "wrong-provider");
    assert.equal(payload, null);
  });

  it("rejects a tampered token", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const tampered = signed.token.slice(0, -5) + "XXXXX";
    const payload = verifyToken(tampered, TEST_PROVIDER);
    assert.equal(payload, null);
  });
});

describe("jwt-signer: verifyTokenWithResult (claim validation)", () => {
  beforeEach(setup);

  it("passes when all claims match", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const result = verifyTokenWithResult(signed.token, {
      providerId: TEST_PROVIDER,
      model: TEST_MODEL,
      baseURL: TEST_BASE,
    });
    assert.equal(result.valid, true);
    assert.ok(result.payload);
  });

  it("fails when sub claim doesn't match", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const result = verifyTokenWithResult(signed.token, { providerId: "other" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "claim_mismatch");
  });

  it("fails when model claim doesn't match", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const result = verifyTokenWithResult(signed.token, { model: "wrong-model" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "claim_mismatch");
  });

  it("fails when aud claim doesn't match", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const result = verifyTokenWithResult(signed.token, { baseURL: "https://other.com" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "claim_mismatch");
  });

  it("passes with no options (backward compatible)", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const result = verifyTokenWithResult(signed.token);
    assert.equal(result.valid, true);
  });

  it("reports invalid_signature for tampered tokens", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const tampered = signed.token + "X";
    const result = verifyTokenWithResult(tampered, { providerId: TEST_PROVIDER });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "invalid_signature");
  });
});

describe("jwt-signer: resignToken", () => {
  beforeEach(setup);

  it("re-signs with fresh timestamps but same session", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);

    const resigned = resignToken(signed.payload);
    assert.ok(resigned);

    // Session ID preserved
    assert.equal(resigned.payload.jti, signed.payload.jti);
    assert.equal(resigned.payload.sub, signed.payload.sub);
    assert.equal(resigned.payload.model, signed.payload.model);
    assert.equal(resigned.payload.aud, signed.payload.aud);

    // Timestamps updated (new token issued later)
    assert.ok(resigned.payload.iat >= signed.payload.iat);
    assert.ok(resigned.payload.exp > signed.payload.exp);
  });

  it("returns null for payload without sub", () => {
    const result = resignToken({
      sub: "",
      model: "m",
      aud: "a",
      iat: 1000,
      exp: 2000,
      jti: "j",
      ver: "v2",
    });
    assert.equal(result, null);
  });

  it("re-signed token passes verification", () => {
    const signed = signToken(TEST_PROVIDER, TEST_MODEL, TEST_KEY, TEST_BASE);
    assert.ok(signed);
    const resigned = resignToken(signed.payload);
    assert.ok(resigned);
    const payload = verifyToken(resigned.token, TEST_PROVIDER);
    assert.ok(payload);
    assert.equal(payload.jti, signed.payload.jti);
  });
});
