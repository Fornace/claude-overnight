# Cross-cutting smells from `agent/simplify-swarm`

## 1. `(msg as any)` SDK casts also live in `src/planner/query.ts`

`src/swarm/message-handler.ts` had 8 `(msg|ev|info as any)` casts; this lane
removes them by narrowing on the SDK's existing discriminators
(`msg.type`, `ev.type`, `cb.type`, `delta.type`).

`src/planner/query.ts` has the same shape — 8 occurrences:

| line | cast |
| ---: | --- |
| 308 | `if (!sessionId && "session_id" in (msg as any))` |
| 310 | `const ev = (msg as any).event;` |
| 336 | `const delta = (ev as any).delta;` |
| 371 | `const u = (msg as any).message?.usage;` |
| 382 | `costUsd: typeof (msg as any).total_cost_usd === "number" …` |
| 387 | `const content = (msg as any).message?.content;` |
| 415 | `const info = (msg as any).rate_limit_info;` |
| 429 | `const r = msg as any;` |

**No new core types are needed** — the upstream SDK already exports
`SDKAssistantMessage`, `SDKResultMessage`, `SDKPartialAssistantMessage`,
`SDKRateLimitEvent`, and (transitively from `@anthropic-ai/sdk`)
`BetaRawContentBlockStartEvent` / `BetaRawContentBlockDeltaEvent` /
`BetaToolUseBlock` / `BetaInputJSONDelta` / `BetaTextDelta` /
`BetaThinkingDelta`. The casts are stale; type narrowing on the
existing discriminators recovers full typing.

A future `agent/simplify-planner-types` lane should mirror what we did
here in message-handler.ts:

- Switch on `msg.type` instead of `(msg as any)`.
- For `stream_event`, switch on `ev.type` to narrow `ev.event`.
- For `content_block_start`, switch on `cb.type` (tool_use → has
  `name`/`input`; thinking/text → no input).
- For `content_block_delta`, switch on `delta.type` (`input_json_delta`,
  `text_delta`, `thinking_delta`).

The narrowing pattern is now exemplified inline in
`src/swarm/message-handler.ts:handleMsg` — copy that style.

## 2. Silent `try { gitExec(...) } catch {}` pattern

This lane introduces `silentGit(cmd, cwd): string | undefined` in
`src/swarm/merge-helpers.ts` and uses it across the merge pipeline.

If other modules grow git-shell helpers (search: `git worktree`,
`git stash`, `git branch -d`), they should reuse `silentGit` rather
than re-introducing `try { gitExec(...) } catch {}`.

No callers outside `src/swarm` currently use `gitExec`.
