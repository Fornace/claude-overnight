# Proxied fast-model research — Skills, tool_use, workspace, and cursor-native translation

Session date: 2026-04-18. Status: **research notes, no code changes yet.** Picks up where `CURSOR_PROXY_MACOS_DISCOVERY.md` left off.

Goal: understand what happens when a proxied Cursor model (composer-2-fast via cursor-composer-in-claude) is dispatched through the Agent SDK's `query()` — specifically whether Anthropic skills and tool-use introspection work, and what would be needed to make proxied fast models feel "just like another endpoint" (qwen-style).

## TL;DR findings

1. **Proxied fast models cannot invoke the Skill tool.** Not a phrasing issue — cursor-agent has its own hardcoded tool loop and treats SDK-provided tools (Skill, Task, sub-Agent, etc.) as text context only.
2. **Zero `tool_use` content blocks surface to the SDK.** cursor-agent emits rich `tool_call` events in its `stream-json` output, but the proxy's `cli-stream-parser.ts` only parses `type:"assistant"` blocks with nested `part.type==="tool_use"`. It drops every `tool_call` event on the floor. ~30 LOC fix.
3. **SDK `cwd` option is ignored** by cursor-agent. Needs per-request `X-Cursor-Workspace` header (already supported by the proxy) + `CURSOR_BRIDGE_WORKSPACE=/` (or broad enough base) for worktree isolation with proxied agents.
4. **Proxy version floor is 0.9.4.** v0.9.2 forced `--mode ask` (read-only); fixed in 0.9.3 but 0.9.3 was never published. `npm install cursor-composer-in-claude@0.9.4` gets agent-mode default.
5. **The cloud endpoint is `https://agentn.global.api5.cursor.sh/agent.v1.AgentService/Run`** — HTTP/2 + protobuf, not JSON. It's an *agent* endpoint, not a pure model endpoint.
6. **Cursor-native rules work perfectly as skill equivalents.** `.cursor/rules/*.mdc` files with frontmatter are discovered, read, and followed by cursor-agent verbatim — including slash-command invocation like `/simplify`.

## Baseline: what works vs doesn't

| | Haiku 4.5 direct | composer-2-fast via proxy (0.9.4) |
|---|---|---|
| `/simplify` Skill invocation | ✅ 12 tool calls, follows skill recipe (3 parallel review agents) | ❌ model says "Skill tool isn't wired up in this session" |
| File actually simplified | ✅ | ✅ (done inline via cursor-agent's internal tools) |
| `tool_use` blocks surface to SDK | ✅ Read, Edit, Bash, Agent visible | ❌ zero — everything is invisible |
| `cwd: <path>` option | ✅ respected | ❌ cursor-agent uses its own workspace resolution |
| Cost | $0.21 | $0.068 (≈3× cheaper) |
| Duration | 41s | 24–43s |

## How I tested

All probes in `/tmp/simplify-probe/` (scratch dir, not committed). Created a trivial messy TypeScript file:

```ts
export function add(a: number, b: number): number {
  const result: number = a + b;
  return result;
}
```

Then spawned `query()` from `@anthropic-ai/claude-agent-sdk` with different model/env combinations, each time asking it to simplify the file.

### 1. Haiku 4.5 direct (baseline)

```js
const agent = query({
  prompt: "Please run /simplify on messy.ts in the current directory.",
  options: { cwd: "/tmp/simplify-probe", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" },
});
```

- **Result:** invoked `Skill({skill:"simplify", args:"messy.ts"})` on turn 1, then launched 3 parallel `general-purpose` subagents (reuse/quality/efficiency), then edited.
- **Tool calls surfaced:** Skill, Read (×2), Bash (×3), Agent (×3), Edit (×1).
- **Cost / time:** $0.21 / 41s.

### 2. composer-2-fast via cursor-composer-in-claude (v0.9.2 — broken)

Symptoms that led us to debug:
- Text reply: *"### Ask mode — I can't run `/simplify` or change messy.ts from here. That needs Agent mode."*
- Zero tool calls.
- File not modified.
- Looked for the file in the proxy's startup cwd, not the SDK's.

Root cause (from `cursor-composer-in-claude/CHANGELOG.md` 0.9.3):

> `--mode agent` is now the default — Previously the proxy always appended `--mode <plan|ask>` to every cursor-agent invocation. Current cursor-agent treats both as strictly read-only (Write/Bash calls are silently dropped, exit 0 with empty stdout).

Fix: `npm install cursor-composer-in-claude@0.9.4`. The package.json already pins `^0.9.4` but our `node_modules` had stale 0.9.2.

### 3. composer-2-fast via v0.9.4 (now agent-mode default)

Model now does real work but:
- Edits `src/__tests__/simplify-target.ts` in the claude-overnight repo instead of `/tmp/simplify-probe/messy.ts`, because it resolves cwd from the proxy's startup dir, not the SDK's `cwd: "/tmp/simplify-probe"` option. **Real bug for claude-overnight worktree isolation.**
- Still zero `tool_use` blocks surfaced. File changes happen through cursor-agent's internal Write tool and don't bubble up.

### 4. composer-2-fast with workspace header (the fix)

```js
const env = envFor(p);
env.ANTHROPIC_CUSTOM_HEADERS = "X-Cursor-Workspace: /tmp/simplify-probe";
// and start proxy with CURSOR_BRIDGE_WORKSPACE=/
```

- Agent SDK honors `ANTHROPIC_CUSTOM_HEADERS` env var (newline-separated `Key: Value` pairs — confirmed in `cli.js` string `ANTHROPIC_CUSTOM_HEADERS`).
- Proxy's `resolveWorkspace()` in `workspace.ts:50` reads `x-cursor-workspace` header; validates that the requested path is under `config.workspace` (the proxy's base). Setting base to `/` (or a broad parent) lets arbitrary worktree paths validate.
- Three prompt variants (`/simplify`, "use the simplify skill", concrete instructions) all simplified correctly now. Still 0 tool_use blocks.

### 5. Forcing the Skill tool explicitly (confirmation test)

Prompt: *"You have a tool named Skill. Invoke it now with parameters {skill: \"simplify\", args: \"messy.ts\"}. Do not do any work yourself — your only job is to emit that one Skill tool call."*

Response: *"I don't have a `Skill` tool in this Cursor session, so I can't emit that call here."*

Confirmed: the model is correctly reporting that the Skill tool isn't actually callable from its vantage point. Not a prompting issue.

## Why tool_use doesn't surface

Ran cursor-agent directly, bypassing the proxy:

```bash
CI=true CURSOR_SKIP_KEYCHAIN=1 CURSOR_API_KEY="..." \
  /opt/homebrew/bin/node /Users/francesco/.local/share/cursor-agent/versions/2026.04.17-479fd04/index.js \
  -p --output-format stream-json --stream-partial-output \
  --trust --workspace /tmp/simplify-probe --model composer-2-fast \
  "read messy.ts then edit it to remove the intermediate result variable"
```

**Cursor-agent emits rich `tool_call` events** (not `tool_use`):

```json
{"type":"tool_call","subtype":"started","call_id":"tool_…","tool_call":{"readToolCall":{"args":{"path":"/tmp/simplify-probe/messy.ts"}}}}
{"type":"tool_call","subtype":"completed","call_id":"tool_…","tool_call":{"readToolCall":{"args":{…},"result":{"success":{"content":"…","totalLines":5,"fileSize":103,"path":"…","readRange":{"startLine":1,"endLine":5}}}}}}
{"type":"tool_call","subtype":"started","tool_call":{"editToolCall":{"args":{"path":"/tmp/simplify-probe/messy.ts","streamContent":"export function add(a: number, b: number): number {\n  return a + b;\n}"}}}}
{"type":"tool_call","subtype":"completed","tool_call":{"editToolCall":{"args":{…},"result":{"success":{"linesAdded":1,"linesRemoved":2,"diffString":"--- a//tmp/simplify-probe/messy.ts\n+++ …"}}}}}
{"type":"tool_call","subtype":"started","tool_call":{"readLintsToolCall":{"args":{"paths":["/tmp/simplify-probe/messy.ts"]}}}}
```

Tool taxonomy observed (there are more — this is just what I triggered):

| cursor-agent event | Mapping to Anthropic standard |
|---|---|
| `readToolCall` | `Read` |
| `editToolCall` | `Edit` (also `Write` when streamContent is full file) |
| `readLintsToolCall` | (no direct equivalent — could be "LSP diagnostics") |
| `globToolCall` | `Glob` |
| `grepToolCall` | `Grep` |
| `shellToolCall` | `Bash` |
| `taskToolCall` | `Task` / `Agent` (parallel sub-agents — confirmed working) |
| `webFetchToolCall` | `WebFetch` |
| `webSearchToolCall` | `WebSearch` |

The proxy's `cli-stream-parser.ts` only handles:

```ts
if (obj.type === "assistant" && obj.message?.content) {
  for (const part of obj.message.content) {
    if (part.type === "text") …
    else if (part.type === "thinking") …
    else if (part.type === "tool_use" && part.id && part.name) …
  }
}
if (obj.type === "result" && obj.subtype === "success") { done = true; onDone(); }
```

**It never matches `obj.type === "tool_call"`.** That's the bug. The `anthropic-sse-writer.ts` at line 59–82 already has a full `kind: "tool_use"` → SSE `content_block_start` path. We just don't feed it.

Fix sketch (~30 LOC in `cli-stream-parser.ts`):

```ts
if (obj.type === "tool_call" && obj.subtype === "started") {
  const [kind, body] = Object.entries(obj.tool_call)[0]; // e.g. ["readToolCall", {args, ...}]
  const name = mapToolName(kind); // readToolCall → Read
  const input = translateArgs(kind, body.args); // keep args shape the Anthropic SDK expects
  onEvent({ kind: "tool_use", id: obj.call_id, name, input });
}
```

(May also need to buffer tool results and forward them as `tool_result` content blocks in the next turn, depending on how the Agent SDK wants to correlate them.)

## The cloud endpoint — what Cursor actually talks to

Instrumented cursor-agent with a `NODE_OPTIONS=--require` preload (`/tmp/simplify-probe/fetch-logger.cjs`) that hooks `global.fetch`, `http.request`, `https.request`, and `http2.connect`. Only http2 captured the real chat traffic — cursor-agent uses undici under the hood, but the chat RPC goes through node:http2.

```
HTTP/2 POST https://agentn.global.api5.cursor.sh/agent.v1.AgentService/Run
Authorization: Bearer <JWT>
Content-Type: (protobuf, inferred — body is binary)
Body: 153 KB for a "what is 2+2" prompt  (!!)
Response: streaming, ~9 KB+ rolling
```

Plus many auxiliary JSON HTTP/1.1 calls to `https://api2.cursor.sh/aiserver.v1.*Service/*`:
- `AnalyticsService/BootstrapStatsig`
- `DashboardService/GetMe`, `GetTeamAdminSettings…`, `GetTeamHooks`, `GetManagedSkills`
- `ServerConfigService/GetServerConfig`
- `AiService/GetUsableModels`, `GetDefaultModelForCli`
- `AnalyticsService/SubmitLogs`, `TrackEvents`
- `DashboardService/GetCliDownloadUrl`
- `/v1/traces` (OTEL)

The chat endpoint `agent.v1.AgentService/Run` is revealing: **it's an agent-loop RPC, not a model-completion endpoint**. It expects the client to hold conversational state, execute tools locally, and feed tool results back for the next step. The 153 KB initial payload carries the whole context (prompt + tool defs + workspace hints + history).

So composer-2-fast's *only* public interface is the agent loop. There's no bare "generate text from this prompt" endpoint to call qwen-style.

## Full path A: bypass cursor-agent (the qwen dream) — not recommended

What it would take:
1. Extract `agent.v1.*` proto schema from `cursor-agent-svc.js` (contains hundreds of message type definitions — looks doable but tedious).
2. Implement protobuf codec for request + streaming response.
3. Handle JWT refresh (observed short-lived tokens ~1h expiry).
4. Translate Anthropic tool_use ↔ cursor tool_call format bidirectionally.
5. Handle all the auxiliary RPCs (`BootstrapStatsig`, `GetUsableModels`, etc.) that cursor-agent fires on startup.
6. Maintain against Cursor's API churn indefinitely.

**Weeks of work, permanent maintenance tax, can break any time.** Probably also violates Cursor's TOS.

Also: even if we do this, SDK-provided tools like Skill wouldn't automatically "just work" — we'd need to map them to cursor's native tool concepts anyway, which we can do without the protobuf spike.

## Full path B+C: fix the parser + expose cursor tools as Anthropic names (recommended)

Scope:

1. **`cli-stream-parser.ts` — translate `tool_call` events to `tool_use` events.** ~30 LOC. Gives the SDK full tool visibility: progress UI, budget tracking, nudge-on-silence, logs.
2. **Tool-name mapping** (tiny table in the proxy): `readToolCall → Read`, `editToolCall → Edit`, `globToolCall → Glob`, `runTerminalToolCall → Bash`, etc.
3. **Rewrite `toolsToSystemText`**: drop SDK-provided tools that cursor-agent can't honor (Skill, Task, sub-Agent) from the system text. Advertise only the cursor-native tools that actually execute, under Anthropic-standard names.

After this, the SDK sees: `assistant → tool_use(Read) → tool_result → tool_use(Edit) → …` exactly like a direct Anthropic session.

## Path D — **skill translation via `.cursor/rules/*.mdc`** (the killer unlock)

cursor-agent supports `.cursor/rules/<name>.mdc` files natively (confirmed: `cursor-agent rule` subcommand, `generate-rule`, rules auto-discovered). Shape:

```markdown
---
description: Short description for the model to decide when to apply
alwaysApply: false
# globs: optional
---
# Rule body

Instructions the agent follows…
```

**Proof that cursor-agent resolves them autonomously** — wrote `/tmp/skilltest/.cursor/rules/simplify.mdc` with a description matching Anthropic's simplify skill, then ran:

```bash
cursor-agent -p --workspace /tmp/skilltest --model composer-2-fast "/simplify messy.ts"
```

First emitted tool call:

```json
{"tool_call":{"readToolCall":{"args":{"path":"/tmp/skilltest/.cursor/rules/simplify.mdc"}}}}
```

**Cursor-agent autonomously discovered, read, and followed the rule.** File was simplified according to the rule body. Full tool stream: read rule → glob for target → read target → edit → lint.

### Translation map

| Anthropic | Cursor |
|---|---|
| `SKILL.md` frontmatter `name`, `description`, `type` | `.mdc` frontmatter `description`, `alwaysApply`, `globs` |
| Skill body | Rule body |
| Skill lives in plugin/user dir | Rule lives in `.cursor/rules/` or `~/.cursor/rules/` |
| Slash invocation `/simplify` | Slash invocation `/simplify` (identical UX — model resolves from description) |
| Model-selected based on task | Model-selected based on task (identical) |
| MCP tools | `.cursor/mcp.json` MCP tools (universal MCP protocol — no translation) |
| `CLAUDE.md` | `.cursor/rules/_always.mdc` with `alwaysApply: true` |

### Proxy behavior after adding skill translation

Per request:
1. Receive Anthropic `/v1/messages` with tools + system + user prompt.
2. Extract skill metadata (names + descriptions). Full bodies either:
   - (a) bundled in the proxy for well-known Anthropic skills, OR
   - (b) sent by claude-overnight as custom headers / system-prompt extra blocks, OR
   - (c) the Agent SDK exposes them via a mechanism TBD.
3. Materialize each advertised skill as `.cursor/rules/<name>.mdc` in the workspace (or per-request temp dir if `chatOnlyWorkspace`).
4. Strip Skill/Task/sub-Agent from `toolsToSystemText` (they're unneeded now — skills live on disk as rules).
5. Run cursor-agent.
6. `tool_call` → `tool_use` translation streams back (from B).

**Result:** from the SDK's view, proxied fast models now honor skills. From cursor-agent's view, it's a normal Cursor session.

### Caveats

- **Skill bodies need to travel** — simplest path: bundle the common ones (simplify, security-review, etc.) with the proxy. Less clean but works day one.
- **Rule-file writes need per-request workspace isolation** — tie-in with the `X-Cursor-Workspace` fix. Don't stomp on parallel agents.
- **`alwaysApply: false`** rules are model-selected based on description — works well in practice (test confirmed composer-2-fast picked up the rule on `/simplify`). For stronger guarantees use `alwaysApply: true` or matching `globs`.
- **Sub-skill chains** (skill A invokes skill B) — Cursor rules can reference other rules (`@ruleName`). Needs a naming convention.
- **Parallel sub-agents DO work.** Earlier version of this doc claimed cursor-agent was single-agent — that was wrong. cursor-agent ships a first-class `TaskToolCall` (proto `agent.v1.TaskToolCallArgsProto`, fields `description`/`prompt`/`model`/`subagent_type`/`resume`/`readonly`/`run_in_background`/`attachments` — identical shape to Anthropic's Task tool). Runtime creates `kind: "subagent"` sessions with their own `agentId`, and the UI explicitly groups parallel `taskToolCall`s. See "Parallel sub-agents — confirmed" below for the empirical test. `/simplify`'s 3-reviewer fan-out replicates directly.

## Parallel sub-agents — confirmed (2026-04-18)

Empirical test that cursor-agent runs sub-agents concurrently, not sequentially.

Setup: `/tmp/subagent-probe/` with `messy.ts` and `.cursor/rules/fanout.mdc`. Rule body instructs the model to spawn three Task sub-agents in a single turn (count lines / count exports / find inline candidates).

Invocation:

```bash
CI=true CURSOR_SKIP_KEYCHAIN=1 CURSOR_API_KEY=… \
  /opt/homebrew/bin/node /Users/francesco/.local/share/cursor-agent/versions/2026.04.17-479fd04/index.js \
  -p --output-format stream-json --trust \
  --workspace /tmp/subagent-probe --model composer-2-fast \
  "/fanout messy.ts"
```

Observed in `stream-json`:

```
other started: readToolCall            # rule discovery
other started: readToolCall            # target file
task started    id=tool_171e…  desc=Count lines in messy.ts
task started    id=tool_d2ab…  desc=Count exports in messy.ts
task started    id=tool_da0d…  desc=Inline candidates in messy.ts
task completed  id=tool_d2ab…
task completed  id=tool_da0d…
task completed  id=tool_171e…
```

Three `taskToolCall`s dispatched in the same assistant turn. **Start order (171e, d2ab, da0d) differs from completion order (d2ab, da0d, 171e) — proves concurrent execution.** Each sub-agent got its own `agentId` and ran its own internal tools independently (one used `shellToolCall` for `wc -l`, the others used `readToolCall`).

Task call payload shape (what the SDK must encode when surfacing):

```json
{
  "taskToolCall": {
    "args": {
      "description": "Count lines in messy.ts",
      "prompt": "Read the file at absolute path /tmp/subagent-probe/messy.ts. Report ONLY the total number of lines…",
      "subagentType": {"unspecified": {}},
      "model": "composer-2-fast",
      "agentId": "0b2fd6e9-9e3f-406a-92b6-8c87072303be",
      "attachments": [],
      "mode": "TASK_MODE_UNSPECIFIED",
      "respondingToMessageIds": []
    },
    "result": {"success": {"conversationSteps": [ /* nested tool calls executed by the subagent */ ]}}
  }
}
```

Totals: 12.1s, 9.8k input / 826 output tokens for the full fan-out including parent aggregation.

**Implications for Path B/D:**

1. `cli-stream-parser.ts` tool-name table must include `taskToolCall → Task` (or `Agent`, whichever name the SDK expects for the parent-visible sub-agent tool).
2. Subagent inner events live inside `result.success.conversationSteps`. Decide whether to flatten them into the outer event stream (so the SDK sees `tool_use(Task) → tool_use(Read) inside → tool_result(Task)` as a nested tree) or collapse them into just the outer Task tool_use/tool_result pair. The latter is simpler and matches Anthropic's Task-tool UX, where sub-agent internals are opaque to the caller.
3. `subagent_type` can be left unspecified; cursor-agent accepts it. `model` defaults to the parent's model (inherited), which is the right default.

Raw stream preserved at `/tmp/subagent-probe/run.jsonl` for later inspection.

## Per-workspace isolation — the adjacent bug

Independent of skills, claude-overnight currently has a real correctness issue for proxied agents in worktrees:

```ts
// src/swarm.ts:578 — current spawn
const agentQuery = query({
  prompt: agentPrompt,
  options: {
    cwd: agentCwd, model: effectiveModel, permissionMode: perm,
    allowedTools: this.config.allowedTools,
    …
  },
});
```

For proxied agents, `cwd: agentCwd` has no effect. Two agents in separate worktrees would both execute in the proxy's startup cwd. Fix:

```ts
const env = this.config.envForModel?.(effectiveModel);
if (env && isCursorProxiedModel(effectiveModel)) {
  env.ANTHROPIC_CUSTOM_HEADERS = `X-Cursor-Workspace: ${agentCwd}`;
}
```

Plus ensure the proxy is started with `CURSOR_BRIDGE_WORKSPACE=/` (or a common parent of all worktree dirs).

This is a separate fix that should land regardless of the skill-translation work.

## Code locations for reference

### `cursor-composer-in-claude` (sibling repo, Francesco's fork at ../cursor-composer-in-claude)

- `src/lib/agent-cmd-args.ts` — builds `--mode` / `--workspace` / `--model` flags. 0.9.3 made `agent` default.
- `src/lib/env.ts:276–281` — `CURSOR_BRIDGE_MODE` parsing (`plan` | `ask` | `agent`).
- `src/lib/env.ts:256–258` — `workspace` config (defaults to proxy's `process.cwd()`).
- `src/lib/workspace.ts:50–106` — `resolveWorkspace()`: reads `x-cursor-workspace` header, validates path is under base.
- `src/lib/handlers/anthropic-messages.ts:147–159` — per-request header-based workspace resolution.
- `src/lib/openai.ts:58–87` — `toolsToSystemText()`: how SDK tool defs get serialized to system-prompt text (this is where to rewrite when exposing cursor tools under Anthropic names).
- `src/lib/cli-stream-parser.ts:41–75` — the parser that needs the `tool_call` case added.
- `src/lib/anthropic-sse-writer.ts:59–82` — already-wired SSE emitter for `tool_use` events.

### `claude-overnight`

- `src/providers.ts:160–215` — `envFor()`: where per-model env (including proxy auth + bridge settings) is built. Add `X-Cursor-Workspace` injection here, driven by the agent's `cwd`.
- `src/swarm.ts:563–584` — agent spawn. `env` is already passed via `envForModel(effectiveModel)`; just needs per-agent cwd propagation.

### Agent SDK (`@anthropic-ai/claude-agent-sdk`)

- `cli.js` — honors `ANTHROPIC_CUSTOM_HEADERS` env var (newline-separated `Key: Value`), string confirmed present.
- `sdk.d.ts:700–710` — `headers` field on McpHttpServerConfig (not the right one for our use — the env var is the right path).

### Cursor

- `https://agentn.global.api5.cursor.sh/agent.v1.AgentService/Run` — the chat RPC (HTTP/2 + protobuf).
- `https://api2.cursor.sh/aiserver.v1.*Service/*` — auxiliary REST/JSON endpoints.
- Proto schema lives in `/Users/francesco/.local/share/cursor-agent/versions/<ver>/cursor-agent-svc.js` (bundled, minified) — contains hundreds of `aiserver.v1.*` / `agent.v1.*` message type definitions.

## Quick artifacts for picking this up later

- Scratch test dir: `/tmp/simplify-probe/` — has all probe scripts (probe.mjs, probe-proxy.mjs, probe-proxy-v2.mjs, probe-proxy-v3.mjs, probe-skill-direct.mjs, fetch-logger.cjs).
- Cursor-rule test dir: `/tmp/skilltest/` — has the `.cursor/rules/simplify.mdc` demo.
- Proxy logs: `/Users/francesco/.cursor-api-proxy/proxy.out.log` and `sessions.log`.
- Cursor-agent CLI: `/Users/francesco/.local/bin/cursor-agent` (avoid — segfaults with bundled Node on macOS); use `/opt/homebrew/bin/node <cursor-agent-install>/index.js` instead.

## Recommended next steps (in order)

1. **Land the `X-Cursor-Workspace` fix in claude-overnight** — independent, fixes a real worktree-isolation bug. Small patch in `providers.ts:envFor()` + start proxy with `CURSOR_BRIDGE_WORKSPACE=/`.
2. **Patch the proxy's `cli-stream-parser.ts`** to translate `tool_call` → `tool_use`. ~30 LOC. Gives full tool visibility in claude-overnight's UI/logs for proxied agents.
3. **Update `toolsToSystemText`** to drop non-executable SDK tools (Skill/Task/sub-Agent) for proxied sessions and list cursor-native tools under Anthropic names.
4. **Bundle skill → rule translation** in the proxy. Start with `/simplify`, `/review`, `/security-review`, `/init`. Materialize into workspace on request. Confirm end-to-end.
5. **Update steering/planner prompts** to give concrete operational briefs instead of skill invocations (works for both direct and proxied models — concrete is the common denominator).
6. **Optional/far future:** Path A (bypass cursor-agent entirely) only if the ceiling of B+C+skill-translation turns out to be too low — which seems unlikely given the experiments so far.
