import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getCachedToken, peekCachedToken, cacheToken, tryRefreshCachedToken, clearTokenCache, revokeSession, clearRevocations, getRevocationCount, } from "../core/token-cache.js";
const TEST_PROVIDER = "test-provider";
const SESSION_ID = "abc123";
function makePayload(expSecFromNow) {
    const now = Math.floor(Date.now() / 1000);
    return {
        sub: TEST_PROVIDER,
        model: "test-model",
        aud: "https://api.example.com",
        iat: now,
        exp: now + expSecFromNow,
        jti: SESSION_ID,
        ver: "v2",
    };
}
function makeRecord(expSecFromNow) {
    const payload = makePayload(expSecFromNow);
    return { signedToken: "fake.jwt.token", payload, sessionId: SESSION_ID };
}
function setup() {
    clearTokenCache();
    clearRevocations();
}
describe("token-cache: getCachedToken", () => {
    beforeEach(setup);
    it("returns null when no token cached", () => {
        assert.equal(getCachedToken(TEST_PROVIDER), null);
    });
    it("returns token with sufficient time remaining", () => {
        const record = makeRecord(60); // 60s remaining
        cacheToken(TEST_PROVIDER, record);
        const result = getCachedToken(TEST_PROVIDER);
        assert.ok(result);
        assert.equal(result.sessionId, SESSION_ID);
    });
    it("returns null when token expires within 30s threshold", () => {
        const record = makeRecord(20); // 20s remaining (< 30s threshold)
        cacheToken(TEST_PROVIDER, record);
        assert.equal(getCachedToken(TEST_PROVIDER), null);
    });
    it("deletes expired token from cache on access", () => {
        const record = makeRecord(20);
        cacheToken(TEST_PROVIDER, record);
        getCachedToken(TEST_PROVIDER); // should evict
        assert.equal(peekCachedToken(TEST_PROVIDER), null);
    });
});
describe("token-cache: peekCachedToken", () => {
    beforeEach(setup);
    it("returns entry regardless of expiry", () => {
        const record = makeRecord(5); // 5s remaining
        cacheToken(TEST_PROVIDER, record);
        const result = peekCachedToken(TEST_PROVIDER);
        assert.ok(result);
        assert.equal(result.sessionId, SESSION_ID);
    });
    it("returns null for missing entry", () => {
        assert.equal(peekCachedToken("nonexistent"), null);
    });
});
describe("token-cache: tryRefreshCachedToken", () => {
    beforeEach(setup);
    it("refreshes token within 60s of expiry", () => {
        const record = makeRecord(45); // 45s remaining (< 60s)
        cacheToken(TEST_PROVIDER, record);
        const refreshed = tryRefreshCachedToken(TEST_PROVIDER, (p) => {
            const now = Math.floor(Date.now() / 1000);
            return { token: "new.jwt.token", payload: { ...p, iat: now, exp: now + 300 } };
        });
        assert.ok(refreshed);
        assert.equal(refreshed.sessionId, SESSION_ID);
        assert.equal(refreshed.signedToken, "new.jwt.token");
    });
    it("does not refresh when plenty of time left", () => {
        const record = makeRecord(120); // 120s remaining (> 60s)
        cacheToken(TEST_PROVIDER, record);
        assert.equal(tryRefreshCachedToken(TEST_PROVIDER, () => null), null);
    });
    it("does not refresh revoked sessions", () => {
        const record = makeRecord(45);
        cacheToken(TEST_PROVIDER, record);
        revokeSession(SESSION_ID);
        assert.equal(tryRefreshCachedToken(TEST_PROVIDER, () => null), null);
    });
    it("returns null when refresher returns null", () => {
        const record = makeRecord(45);
        cacheToken(TEST_PROVIDER, record);
        assert.equal(tryRefreshCachedToken(TEST_PROVIDER, () => null), null);
    });
});
describe("token-cache: revokeSession", () => {
    beforeEach(setup);
    it("revoked session blocks getCachedToken", () => {
        const record = makeRecord(300);
        cacheToken(TEST_PROVIDER, record);
        revokeSession(SESSION_ID);
        assert.equal(getCachedToken(TEST_PROVIDER), null);
    });
    it("evicts token from cache on revoke", () => {
        const record = makeRecord(300);
        cacheToken(TEST_PROVIDER, record);
        revokeSession(SESSION_ID);
        assert.equal(peekCachedToken(TEST_PROVIDER), null);
    });
    it("increment revocation count", () => {
        const before = getRevocationCount();
        revokeSession("session-1");
        assert.equal(getRevocationCount(), before + 1);
    });
});
describe("token-cache: revocation pruning", () => {
    beforeEach(setup);
    it("clearRevocations removes all revocations", () => {
        revokeSession("s1");
        revokeSession("s2");
        revokeSession("s3");
        assert.ok(getRevocationCount() > 0);
        clearRevocations();
        assert.equal(getRevocationCount(), 0);
    });
    it("old revocations are pruned automatically", () => {
        // Directly add old entries to the revocation map
        // We test this by adding many sessions and checking the cap
        const MAX = 500;
        for (let i = 0; i < MAX + 50; i++) {
            revokeSession(`session-${i}`);
        }
        // After pruning, should not exceed the max
        assert.ok(getRevocationCount() <= MAX, `Expected <= ${MAX}, got ${getRevocationCount()}`);
    });
});
describe("token-cache: clearTokenCache", () => {
    beforeEach(setup);
    it("removes all cached tokens", () => {
        cacheToken("p1", makeRecord(300));
        cacheToken("p2", makeRecord(300));
        cacheToken("p3", makeRecord(300));
        clearTokenCache();
        assert.equal(getCachedToken("p1"), null);
        assert.equal(getCachedToken("p2"), null);
        assert.equal(getCachedToken("p3"), null);
    });
});
