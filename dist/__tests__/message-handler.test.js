import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkStreamHealth } from "../swarm/message-handler.js";
describe("checkStreamHealth", () => {
    it("returns false when the timestamp is older than timeoutMs", () => {
        const stale = Date.now() - 30_000;
        assert.equal(checkStreamHealth(stale, 15_000), false);
    });
    it("returns true when content arrived within timeoutMs", () => {
        const recent = Date.now() - 5_000;
        assert.equal(checkStreamHealth(recent, 15_000), true);
    });
});
