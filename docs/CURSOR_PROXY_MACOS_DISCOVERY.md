# Cursor bundled proxy on macOS: Keychain, ACP, parallel safety

This document records **why** the Cursor API proxy (`cursor-composer-in-claude`) is tricky to run headlessly (macOS Keychain dialogs, parallel crashes, model-name mismatches), **what did not fix it**, and the **env vars + account-pool setup** `claude-overnight` now ships as defaults.

---

## Context

- **claude-overnight** bundles **cursor-composer-in-claude**, an Anthropic-compatible HTTP server that forwards requests to the Cursor **`agent`** CLI. cursor-composer has **two agent paths**: **CLI streaming** (default, `useAcp=false`) and **ACP** (JSON-RPC over stdio, `useAcp=true`).
- Headless use is supposed to rely on a **[User API key](https://cursor.com/docs/cli/headless)** (`CURSOR_API_KEY`), not on interactive login stored as **`cursor-user`** in the login keychain.

Three independent failure modes were mixed together in early reports: **Keychain contention**, **ACP model-name mismatch**, and a **`cli-config.json` write race** under parallel load.

---

## Failure mode 1: Keychain contention (chat-only workspace + temp `HOME`)

- cursor-composer defaults **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=true`**. For each request it creates a temp dir and sets **`HOME`** (and related profile vars) to that temp dir so rules from the real `~/.cursor` are not loaded.
- With a valid User API key in env, `composer-2` could still hit **`Keychain operation timed out after 30000ms`** under chat-only. Setting **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`** made the same call succeed — the Cursor CLI was probing Keychain for `cursor-user` when its profile view was empty, even though API key auth was set.
- **Fix shipped:** spawn the proxy with `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`. Trade-off: the agent no longer runs with a disposable fake `HOME` per request.
- Orthogonally, cursor-composer injects **`keychain-shim-inject.js`** via `NODE_OPTIONS` on macOS (see `node_modules/cursor-composer-in-claude/dist/lib/keychain-shim-inject.js`). It no-ops `/usr/bin/security` at the Node level for spawned agents — Keychain safety is preserved on the CLI streaming path without needing ACP's `skipAuthenticate`.

---

## Failure mode 2: ACP model-name mismatch (opus/sonnet `*-thinking-*`)

- `agent --list-models` returns friendly IDs like `claude-opus-4-7-thinking-high`, `gemini-3.1-pro`.
- The ACP model catalog only exposes **bracketed** IDs keyed by stripped `name` fields: `claude-opus-4-7` with `modelId: claude-opus-4-7[thinking=true,effort=high]`. cursor-composer's `resolveAcpModelConfigValue` has no mapping from `claude-opus-4-7-thinking-high` to the bracketed form.
- When `USE_ACP=1`, the ACP agent replies:
  ```
  {"error":{"code":-32602,"message":"Invalid params","data":{"message":"Invalid model value: claude-opus-4-7-thinking-high"}}}
  ```
  `acp-client.js` swallows this RPC error to a silent `exit 1`, which the proxy surfaces as:
  ```
  HTTP 500: The Cursor agent process exited with code 1. See server logs for details.
  ```
- **Fix shipped:** force **`CURSOR_BRIDGE_USE_ACP=0`**. The CLI streaming path accepts every `agent --list-models` friendly name (verified: `claude-opus-4-7-thinking-high`, `gemini-3.1-pro`, `composer-2`). Keychain safety is preserved by the `NODE_OPTIONS` shim above.
- `CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE` is no longer needed and no longer set: the CLI path never calls `cursor_login`.

---

## Failure mode 3: `cli-config.json` write race (parallel spawns)

- Every `cursor-agent` subprocess rewrites `~/.cursor/cli-config.json` on startup using atomic tmp+rename. N sibling spawns race on the `rename(*.tmp → cli-config.json)` step and intermittently raise:
  ```
  ERROR POST /v1/messages 127.0.0.1 agent_exit_1
  Error: ENOENT: no such file or directory,
  rename '/Users/x/.cursor/cli-config.json.tmp' -> '/Users/x/.cursor/cli-config.json'
  ```
- Observed hit rate: ~20% (3/15 queries) at swarm concurrency 5 with shared config. Preflights with 3 cursor providers hit it too.
- cursor-composer has a built-in **AccountPool**: when `CURSOR_CONFIG_DIRS=<dir1,dir2,…>` is set (or `~/.cursor-api-proxy/accounts/<name>/cli-config.json` contains `authInfo.email`), it round-robins spawns across the dirs, each exported to the agent as its own `CURSOR_CONFIG_DIR`. Separate files, no shared rename target, no race.
- **Fix shipped:** `ensureCursorAccountPool()` in `src/providers.ts` clones `~/.cursor/cli-config.json` into `~/.cursor-api-proxy/accounts/pool-{1..5}` on startup and exports `CURSOR_CONFIG_DIRS` to the proxy. Pool is refreshed every startup so token rotations in `~/.cursor` propagate.
- **Verified:** 25/25 across 5 rounds × 5 parallel `composer-2` requests, zero `agent_exit_1` / `cli-config.json.tmp` entries in `~/.cursor-api-proxy/sessions.log`.
- **Preflight impact:** 3 cursor providers in parallel drop from ~21s sequential to ~8s.

---

## What claude-overnight sets when it auto-starts the proxy

`startProxyProcess` in `src/providers.ts` builds a `proxyEnv` that always includes:

| Variable | Value | Purpose |
|---|---|---|
| `CI` | `"true"` | Forced; prevents a parent shell from re-enabling interactive probes. |
| `CURSOR_SKIP_KEYCHAIN` | `"1"` | Cursor's own CI convention. |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | User API key | Headless auth for the native agent; mirrored into the proxy spawn env because GUI launches can omit them. |
| `CURSOR_BRIDGE_API_KEY` | Same token | HTTP bearer for the proxy's `/health` and `/v1/*`. |
| **`CURSOR_BRIDGE_USE_ACP`** | **`"0"`** | CLI streaming path; avoids the ACP model-name mismatch for `*-thinking-*` variants. |
| **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE`** | **`"false"`** | Avoids temp `HOME` → Keychain waits on macOS. |
| **`CURSOR_CONFIG_DIRS`** | **`pool-1,…,pool-5`** | Cloned from `~/.cursor/cli-config.json`; eliminates the write race under parallel spawns. |
| `CURSOR_AGENT_NODE` / `CURSOR_AGENT_SCRIPT` | When detected | System Node + `agent/index.js` (avoids known issues with the bundled Node on some macOS installs). |

Startup logs print an `accountPool` field in `spawnProxy.childEnv` showing how many pool dirs are active.

---

## How to verify

1. **Matrix (recommended):**
   ```
   MATRIX_MODELS=composer-2,claude-opus-4-7-thinking-high npm run matrix:cursor-proxy
   ```
   All rows (including thinking variants) should return **HTTP 200**.

2. **Parallel smoke (manual):** fire 5 concurrent `POST /v1/messages` at `composer-2` through the running proxy. With the account pool enabled, expect 5/5 200s and zero `agent_exit_1` in `~/.cursor-api-proxy/sessions.log`.

3. **Logs:** claude-overnight redirects proxy stdout+stderr to `~/.cursor-api-proxy/proxy.out.log` and prints a tail on preflight failure. cursor-composer's own request trace is `~/.cursor-api-proxy/sessions.log`.

4. **Preflight:** claude-overnight runs provider preflights fully in parallel (HTTP `POST /v1/messages` with `max_tokens: 4096`, not a claude-CLI spawn). Cursor proxy providers ride the account pool.

---

## When the OS keychain itself is broken

If **`login.keychain`** is missing or damaged, macOS can still show dialogs unrelated to Cursor. Keychain Access → First Aid, or `security unlock-keychain ~/Library/Keychains/login.keychain-db`, may help. That is **orthogonal** to the chat-only / ACP / pool discoveries above.

---

## References in this repo

- Implementation: `src/providers.ts` (`startProxyProcess`, `ensureCursorAccountPool`, `preflightCursorProxyViaHttp`, `readCursorProxyLogTail`).
- Preflight strategy: `src/index.ts` (all providers parallel via `Promise.all`).
- Stress harness: `scripts/cursor-proxy-keychain-matrix.mjs`, `npm run matrix:cursor-proxy`.
- Upstream behavior: `node_modules/cursor-composer-in-claude/dist/lib/` — `env.js` (`configDirs` discovery), `account-pool.js` (round-robin), `process.js` (sets `CURSOR_CONFIG_DIR` from pool), `workspace.js` (`getChatOnlyEnvOverrides`), `acp-client.js` (`resolveAcpModelConfigValue` and the error-swallowing `exit 1`), `keychain-shim-inject.js` (`/usr/bin/security` no-op).

---

## Summary

1. **`CURSOR_BRIDGE_USE_ACP=0`** routes requests through the CLI streaming path, which accepts every friendly model name including opus/sonnet `*-thinking-*`.
2. **`CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`** stops temp-`HOME` from driving Keychain waits on macOS. The `NODE_OPTIONS` shim (`keychain-shim-inject.js`) keeps `/usr/bin/security` from reaching macOS.
3. **`CURSOR_CONFIG_DIRS=<pool-1,…,pool-5>`** gives each parallel cursor-agent subprocess its own `cli-config.json` — no more `rename(.tmp→cli-config.json)` race under swarm concurrency or parallel preflights.
