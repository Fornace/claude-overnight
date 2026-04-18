# Cursor proxy — operational notes

claude-overnight routes Cursor-hosted models (`composer-2`, `composer-2-fast`, `auto`, etc.) through a local HTTP proxy from the [`cursor-composer-in-claude`](https://www.npmjs.com/package/cursor-composer-in-claude) package (Francesco's fork at `../cursor-composer-in-claude`). The proxy speaks Anthropic's `/v1/messages` protocol and spawns the `cursor-agent` CLI behind the scenes.

This doc captures the load-bearing gotchas. When something looks wrong on a Cursor-backed run, re-read this first.

## Three behaviors that differ from direct Anthropic

1. **No `tool_use` blocks stream back.** `cursor-agent` is a black box — its internal Read/Edit/Bash calls never appear in the SDK's event stream. Only final assistant text arrives. Anything that observes tool events (logging, per-tool nudges, budget accounting) must hook on text/message activity instead.
2. **Slash skills don't invoke the Skill tool.** `/simplify` is parsed as natural language; the model replies "Skill tool isn't wired up in this chat" and does the task inline, without the parallel-review recipe the skill encodes. Write concrete operational briefs ("read X, edit Y, run Z") — they work for both direct Anthropic and proxied models.
3. **SDK `cwd` option is ignored.** cursor-agent uses its own workspace resolution. A proxied agent spawned with `cwd: /worktrees/agent-7` actually operates in the proxy's startup cwd — a real correctness bug for worktree isolation unless the workspace header below is injected.

## The X-Cursor-Workspace header (load-bearing)

For worktree isolation to work on proxied runs:

1. The **proxy process** must start with `CURSOR_BRIDGE_WORKSPACE=/` (or a parent directory of every worktree path). This is the safety-check base — the proxy rejects per-request workspace overrides that aren't under it.
2. **Each `query()` call** must pass `ANTHROPIC_CUSTOM_HEADERS` containing `X-Cursor-Workspace: <agent cwd>`. The Agent SDK forwards custom headers; the proxy reads the header and sets cursor-agent's `--workspace` to that path.

Injection lives in `src/swarm/config.ts::withCursorWorkspaceHeader`. Call it wherever we build per-agent env. **Do not match by URL** — see next section.

## Per-project proxy port

`getProxyPort(cwd)` resolves a deterministic port from the project root hash. The proxy commonly binds to something like `:62717`, not the default `:8765`. Anything gated on "is this env talking to the proxy?" must:

- **Detect via env vars**, not URL equality. The cursor-specific variables set by `envFor(p)` are the reliable markers:
  - `CURSOR_API_KEY`
  - `CURSOR_AUTH_TOKEN`
  - `CURSOR_BRIDGE_MODE`
- **Never** compare `env.ANTHROPIC_BASE_URL === PROXY_DEFAULT_URL`. That silently bypasses header injection whenever the proxy isn't on the default port. Commit `34d1865` fixed this exact bug.

## Symptom → cause quick map

| Symptom | Likely cause |
| --- | --- |
| Agents run for minutes, zero tool_use, cost accruing | `X-Cursor-Workspace` header missing — check `withCursorWorkspaceHeader` gate |
| Agents write to the wrong directory (not their worktree) | Same as above, or proxy not started with `CURSOR_BRIDGE_WORKSPACE=/` |
| Proxy returns 200 but response body is empty | cursor-agent running in `--mode ask` or `--mode plan` (read-only). Requires `CURSOR_BRIDGE_MODE=agent` (default) and proxy ≥ 0.9.4 |
| `write probe: rate limit: min interval not elapsed` at startup | Self-inflicted: `apiEndpointLimiter.assertCanRequest()` in preflight. Use `waitIfNeeded()` instead. Fixed in `e3328c3` |
| Proxy keychain dialog pops up on macOS | `CURSOR_SKIP_KEYCHAIN=1` not set. `envFor(p)` sets it; if you spawn children yourself, propagate it |
| Slow cold start (~30s+ per provider) | Preflight running. Opt in only when needed: `--preflight` or `RUN_PREFLIGHT=1` |

## Version floor

- `cursor-composer-in-claude` **≥ 0.9.4**. Earlier versions forced `--mode ask` which silently drops Write/Bash. `package.json` already pins `^0.9.4`.
- Proxy v0.9.3 never published; v0.9.4 is the real minimum.

## When to use proxied Cursor models

Measured on a simplify task for a 13-line file:

- composer-2-fast via proxy: ~$0.068, 24–43 s per run
- Haiku 4.5 direct: ~$0.21, ~41 s per run

~3× cheaper when workspace resolution and mode are correct. The fast models produce usable output on concrete briefs, just not on skill-expanded prompts. Good fit for mechanical single-file work; bad fit for anything that depends on multi-tool orchestration you can't see.

## Files to know

- `src/providers/cursor-proxy.ts` — health check, auto-start, preflight HTTP probes
- `src/providers/cursor-env.ts` — `envFor` builds the env with all required variables
- `src/providers/cursor-picker.ts` — UI for adding Cursor providers
- `src/swarm/config.ts::withCursorWorkspaceHeader` — the workspace-header injection point
- `src/planner/query.ts::runViaDirectFetch` — bypasses the SDK and POSTs `/v1/messages` directly for planner calls (4–10× faster than the SDK path on proxied envs)
