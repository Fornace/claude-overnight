import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { envFor, PROXY_DEFAULT_URL, hasCursorAgentToken, getCursorAgentToken } from "../providers.js";
import type { ProviderConfig } from "../providers.js";

describe("Cursor env injection (keychain avoidance)", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.CURSOR_BRIDGE_API_KEY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("envFor sets CURSOR_API_KEY when CURSOR_API_KEY is in the environment", () => {
    process.env.CURSOR_API_KEY = "env-key-123";
    const p: ProviderConfig = {
      id: "cursor-x",
      displayName: "Cursor",
      baseURL: PROXY_DEFAULT_URL,
      model: "composer-2",
      cursorProxy: true,
    };
    const e = envFor(p);
    assert.equal(e.CURSOR_API_KEY, "env-key-123");
    assert.equal(e.CURSOR_AUTH_TOKEN, "env-key-123");
    assert.equal(e.CI, "true");
    assert.equal(e.CURSOR_SKIP_KEYCHAIN, "1");
    assert.equal(e.ANTHROPIC_AUTH_TOKEN, "env-key-123");
  });

  it("hasCursorAgentToken / getCursorAgentToken reflect env", () => {
    process.env.CURSOR_API_KEY = "k1";
    assert.equal(hasCursorAgentToken(), true);
    assert.equal(getCursorAgentToken(), "k1");
  });
});
