# Cursor bundled proxy on macOS: Keychain, ACP, and what actually fixed it

This document records **why** the Cursor API proxy (`cursor-composer-in-claude`) triggered macOS Keychain dialogs and long hangs on automation, **what did not fix it**, and **which environment variables and model choices** make headless runs reliable. It is written for maintainers and for anyone debugging similar “it still asks for Keychain” reports.

---

## Context

- **claude-overnight** can bundle **cursor-composer-in-claude**, which exposes an Anthropic-compatible HTTP server and forwards requests to the Cursor **`agent`** CLI (often via **ACP**, the Agent Client Protocol over stdio).
- Headless use is supposed to rely on a **[User API key](https://cursor.com/docs/cli/headless)** (`CURSOR_API_KEY` / dashboard), not on interactive login stored as **`cursor-user`** in the login keychain.
- Despite setting `CURSOR_SKIP_KEYCHAIN=1`, `CI=true`, and API keys, macOS could still show Keychain UI or block for ~30s with errors like **`Keychain operation timed out after 30000ms`** in the proxy log (`~/.cursor-api-proxy/sessions.log` or stderr).

---

## Symptoms we saw

1. **GUI:** System Keychain prompts, or “Keychain Not Found” style dialogs for `cursor-user`.
2. **Proxy logs:** `Agent error: Cursor CLI failed (exit 1): Error: Keychain operation timed out after 30000ms`.
3. **Stress tests:** Every matrix row returning **HTTP 500** looked like one bug; in reality **two different failure modes** were mixed (see below).

---

## What we tried that was necessary but not sufficient

These are still **correct** to set; they address real issues, but they did **not** alone stop Keychain contention on macOS.

| Measure | Role |
|--------|------|
| **`CURSOR_SKIP_KEYCHAIN=1`** + **`CI=true`** | Cursor’s own convention to discourage interactive keychain probes in CI-style runs. |
| **`CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`** (User API key) | Headless auth for the native agent; must be injected into the **proxy process** env, not only the parent shell (GUI launches often omit them). |
| **`CURSOR_BRIDGE_API_KEY`** | HTTP bearer for the proxy’s `/health` and `/v1/*` routes; often mirrored from the same token. |
| **`CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE=1`** | In `cursor-composer-in-claude`, `loadBridgeConfig` sets `acpSkipAuthenticate` when this is on **or** when an API key is present. Skips the ACP **`authenticate` / `cursor_login`** step that can touch Keychain. |
| **`CURSOR_BRIDGE_USE_ACP=1`** | Default bridge config has **`useAcp: false`**. Without ACP, traffic used **`runStreaming`** instead of **`runAcpStream`**; skip-authenticate only applies on the **ACP** path. Forcing ACP keeps behavior aligned with the intended headless/ACP pipeline. |

Without **`CURSOR_BRIDGE_USE_ACP=1`**, skip-authenticate did not apply to the code path that handled streaming requests.

---

## Discovery 1: Chat-only workspace and a fake `HOME` (main Keychain fix)

**cursor-composer** defaults **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE`** to **`true`** (“chat-only workspace: yes (isolated temp dir)” in the startup banner).

For each request it:

- Creates a **temporary directory** and points **`CURSOR_CONFIG_DIR`** at a minimal tree under it.
- In **`getChatOnlyEnvOverrides`** (when no account-pool `authConfigDir`), it sets **`HOME`** (and related profile vars) to that **temp** directory so rules from the real `~/.cursor` are not loaded.

**Observation:** With a valid User API key in env, **`composer-2`** could still hit **`Keychain operation timed out after 30000ms`** when chat-only was **on**. With **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`**, the same model and key **succeeded** (real workspace / real profile resolution, no temp `HOME`).

**Interpretation:** The Cursor CLI in ACP mode was still probing macOS Keychain for `cursor-user` when the process believed it was in an isolated “empty” profile (temp `HOME`), even though API key auth was set. That matches a **profile / keychain resolution** path, not a missing `CURSOR_API_KEY` in the parent shell.

**Fix shipped in claude-overnight:** spawn the bundled proxy with **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`**.

**Trade-off:** You lose the strictest isolation (the agent no longer runs with a disposable fake `HOME` for every request). You gain reliable headless behavior on macOS with API keys. For many automation setups this is the right default.

**How to see it in tests:** The matrix script includes a row **`12-chat-workspace-isolated`** (`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=true`). With **`composer-2`**, that row tends to **fail** while **`01-overnight-parity`** passes, reproducing the regression.

---

## Discovery 2: `composer-2-fast` was never a real model

The ACP model catalog only offers `composer-2` with `modelId: composer-2[fast=true]`. There is no separate `composer-2-fast` model — `composer-2` already IS the fast variant. Passing `composer-2-fast` to `session/set_config_option` fails with "Invalid model value" because it's not in the catalog. Use **`composer-2`** as the model name.

---

## What claude-overnight sets when it auto-starts the proxy

When `startProxyProcess` runs, it builds a **`proxyEnv`** that always includes (among others):

| Variable | Purpose |
|----------|--------|
| `CI` | `"true"` (forced so a parent shell cannot leave `CI` empty and re-enable interactive probes). |
| `CURSOR_SKIP_KEYCHAIN` | `"1"` (forced). |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | Resolved User API key / bridge key (same token mirrored for the native agent). |
| `CURSOR_BRIDGE_API_KEY` | HTTP auth for the proxy. |
| `CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE` | `"1"` (skip `cursor_login` on ACP). |
| `CURSOR_BRIDGE_USE_ACP` | `"1"` (use ACP path so skip-authenticate applies). |
| **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE`** | **`"false"`** (avoid temp `HOME` Keychain behavior on macOS). |
| `CURSOR_AGENT_NODE` / `CURSOR_AGENT_SCRIPT` | When detected: system Node + `agent` `index.js` (avoids known issues with the bundled Node on some macOS installs). |

See `startProxyProcess` in `src/providers.ts` for the exact spawn and logging.

---

## How to verify

1. **Matrix (recommended):**  
   `MATRIX_MODELS=composer-2 npm run matrix:cursor-proxy`  
   - Expect **`composer-2`** parity row **HTTP 200**.

2. **Logs:** On failure, check proxy stderr / `~/.cursor-api-proxy/sessions.log` for **`Keychain operation timed out`** vs empty stderr / generic exit 1.

3. **Preflight:** claude-overnight runs provider preflights with timeouts; Cursor proxy preflights are serialized to avoid starving the single agent listener.

---

## When the OS keychain itself is broken

If **`login.keychain`** is missing or damaged, macOS can still show dialogs unrelated to Cursor. Keychain Access → First Aid, or `security unlock-keychain ~/Library/Keychains/login.keychain-db`, may help. That is **orthogonal** to the chat-only / `HOME` discovery above.

---

## References in this repo

- Implementation: `src/providers.ts` (`startProxyProcess`, `envFor`, `ensureCursorProxyRunning`).
- Stress harness: `scripts/cursor-proxy-keychain-matrix.mjs`, `npm run matrix:cursor-proxy`.
- Upstream behavior: `node_modules/cursor-composer-in-claude/dist/lib/config.js` (`loadBridgeConfig`), `workspace.js` (`getChatOnlyEnvOverrides`), `acp-client.js` (`buildAcpSpawnEnv`, ACP handshake).

---

## Summary

1. **ACP + skip-authenticate + USE_ACP** are required so the bridge uses the path where headless auth is designed to apply.  
2. **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`** is the macOS-specific fix that stops temp-`HOME` isolation from driving Keychain waits despite API keys.  
3. **Keychain shim** (`NODE_OPTIONS=--require keychain-shim.cjs`) intercepts `/usr/bin/security` calls at the Node.js level, eliminating macOS Keychain dialogs regardless of other env vars.  
4. Use **`composer-2`** as the model name — `composer-2-fast` was never a real model in the ACP catalog.
