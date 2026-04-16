# Brief — enable real streaming in `cursor-composer-in-claude`

**Audience:** agent picking up a task in https://github.com/grisentti/cursor-composer-in-claude (the proxy that `claude-overnight` bundles to let Cursor models impersonate Anthropic's Messages API).

**Stakeholder:** `claude-overnight`. When our planner/steering queries go through this proxy, the live UI just shows `⠋ 6m 26s` for the entire reasoning phase. That's because the proxy does stream, but only emits `text_delta` on the *final* answer — no `tool_use`, no `thinking_delta`, no chunked reasoning. A 6-minute silence looks like a hang to the user even though everything is fine.

## Current behavior (reference)

Streaming SSE handler lives in `dist/lib/handlers/anthropic-messages.js` (source at `src/lib/handlers/anthropic-messages.ts`, proxy version `0.8.0`).

Shape today, when `body.stream === true`:

1. `message_start` (empty assistant message)
2. `content_block_start { index: 0, content_block: { type: "text", text: "" } }`
3. Many `content_block_delta { delta: { type: "text_delta", text: <chunk> } }` emitted by `createStreamParser` from `dist/lib/cli-stream-parser.js` as cursor-agent's stdout JSON lines arrive.
4. `content_block_stop`, `message_delta { stop_reason: "end_turn" }`, `message_stop`.

The parser only looks at `type === "assistant"` lines, extracts `message.content[].text`, diffs against what's already been sent, and forwards the delta. Tool uses, thinking tokens, and status events emitted by cursor-agent's stream-json are thrown away.

The ACP branch (`config.useAcp === true`) is worse — it uses `runAgentStream(..., (chunk) => ...)` with raw text chunks only, no structure at all.

## What consumers need

The **Claude Agent SDK** (used by `claude-overnight` and anything else speaking Anthropic's SSE) is happy to consume any of these event types if the proxy emits them — `includePartialMessages: true` surfaces them as `stream_event` messages:

- `content_block_start` with `content_block.type === "tool_use"` (so the UI can show "Read → src/foo.ts")
- `content_block_delta` with `delta.type === "thinking_delta"` / `{ thinking: "..." }` (so reasoning models show progress mid-think)
- `content_block_delta` with `delta.type === "text_delta"` (already works)
- `rate_limit_event` or an approximation thereof (optional; nice-to-have)

`claude-overnight` already handles all of these — see `src/planner-query.ts::runPlannerQueryOnce` — so any one we enable immediately lights up both the ticker and the NDJSON transcripts without further changes on our side.

## Goal

Make a thinking/tool-calling run on the Cursor proxy feel the same as a native Anthropic run: continuous visible progress, either thinking deltas or tool-use events, never a multi-minute silence.

## Approach

**Inspect what cursor-agent actually streams first.** Run the agent directly with the same `--stream-json` / ACP flags the proxy uses and log every stdout line. Likely shape (from `cli-stream-parser.js`): one JSON object per line, at least:

- `{ type: "assistant", message: { content: [{type: "text", text: "..."}] } }` — already handled
- Tool events — inspect. Cursor CLI emits them; the parser currently drops them.
- Reasoning / thinking events — inspect. Some Cursor reasoning models expose them; confirm.

Knowing the actual shape is the unblock — everything below assumes you've captured a real trace.

### Phase 1 — forward tool uses

In `createStreamParser` (`src/lib/cli-stream-parser.ts`), add branches for whatever cursor-agent emits that corresponds to tool calls. Expose them to the handler as a second callback, e.g. `createStreamParser({ onText, onToolUse, onDone })`. In `handlers/anthropic-messages.ts`, when `onToolUse` fires mid-stream:

1. Close the current text block: `writeEvent({ type: "content_block_stop", index: currentIndex })`.
2. Open a new tool block:
   ```ts
   writeEvent({
     type: "content_block_start",
     index: ++currentIndex,
     content_block: { type: "tool_use", id, name, input: {} }
   });
   writeEvent({
     type: "content_block_delta",
     index: currentIndex,
     delta: { type: "input_json_delta", partial_json: JSON.stringify(input) }
   });
   writeEvent({ type: "content_block_stop", index: currentIndex });
   ```
3. Reopen a text block (`++currentIndex`) so subsequent text deltas have a home.

Even a best-effort mapping is a huge UX win — users see "Read → package.json", "Grep → auth/*", etc., instead of a silent spinner.

### Phase 2 — forward thinking deltas

If cursor-agent exposes reasoning events for thinking models, forward them as:

```ts
writeEvent({
  type: "content_block_start",
  index,
  content_block: { type: "thinking", thinking: "" }
});
writeEvent({
  type: "content_block_delta",
  index,
  delta: { type: "thinking_delta", thinking: <chunk> }
});
// …more deltas as they arrive…
writeEvent({ type: "content_block_stop", index });
```

If cursor-agent does *not* expose reasoning events separately (likely for the Cursor-hosted Opus-thinking variant), at minimum emit a periodic heartbeat:

```ts
writeEvent({
  type: "content_block_start",
  index,
  content_block: { type: "thinking", thinking: "" }
});
```

…right after `message_start`, so consumers know the model is thinking even if no content follows for minutes. This alone would kill the "6m silence" symptom.

### Phase 3 (optional) — surface stderr signals as rate-limit events

When `runAgentStream`'s stderr contains a 429 / "rate limit" hit (already detected by `isRateLimited()` for account-pool bookkeeping), emit:

```ts
writeEvent({
  type: "rate_limit_event",
  rate_limit_info: { utilization: 0.95, status: "rejected", resetsAt: <ms> }
});
```

Our throttle code consumes this directly; today we only find out after the whole request errors.

## Files to touch

- `src/lib/cli-stream-parser.ts` — add tool/thinking branches, widen the callback surface
- `src/lib/handlers/anthropic-messages.ts` — emit the new block types with correct `index` bookkeeping
- `src/lib/agent-runner.ts` — confirm the stdout line-splitter doesn't lose events; if the ACP path is also needed for tool models, mirror the changes in the ACP branch
- Add a fixture-driven test in `src/lib/cli-stream-parser.test.ts` capturing a real cursor-agent trace so future cursor CLI updates don't silently regress

## Acceptance criteria

1. `curl` against the proxy with `{"stream": true, "model": "claude-opus-4-7-thinking-high", ...}` yields at least one non-`text_delta` event before the first text appears (either `thinking_delta`, `thinking` content_block_start, or a `tool_use` block).
2. Running `claude-overnight` in `--dry-run` or with a short planning prompt against a Cursor model shows live ticker text (tool names or thinking snippets) instead of bare elapsed time.
3. `runs/<ts>/transcripts/themes.ndjson` contains at least one `tool_use` or `thinking_start` event per planner query when the planner is a Cursor model.
4. No regression for existing text-only consumers (plain `claude-3-5-sonnet` style flows still stream identically).
5. Proxy tests pass (`pnpm test` / `npm test`).

## Gotchas

- **`index` must be contiguous and monotonic** across all blocks inside one `message`. Off-by-one there will break the SDK parser.
- `input` on tool_use blocks is incrementally streamed via `input_json_delta` in Anthropic's real API. A single serialized blob is acceptable for our use (SDK just concatenates), but spec-pure implementations chunk it.
- Account-pool bookkeeping (`reportRequestStart/End/Success/Error/RateLimit`) must still fire exactly once per request regardless of how many blocks were emitted.
- `req.once("close", ...)` already aborts the upstream cursor-agent — keep that path intact; tool/thinking writes must not mask an abort.
- The Cursor proxy is started as a background subprocess by `claude-overnight`; after changes, bump the proxy version and update the `claude-overnight` pin (`package.json` + `package-lock.json`) rather than symlinking — the bundled version is what end users get.
- Output buffering: double-check `res.flushHeaders()` is called in `writeSseHeaders` and that the socket has `setNoDelay(true)`, otherwise Node may coalesce small events and defeat the point.

## Nice-to-have, out of scope for v1

- `message_delta` with incremental `usage.output_tokens` so we can track spend during the stream, not just at the end.
- Per-content-block IDs surfaced on `tool_use` so the SDK can correlate `tool_result` messages on resume (currently we never resume a Cursor session mid-tool, so not urgent).

## Test plan

1. Capture a real cursor-agent stdout/stderr trace for: (a) a simple text prompt, (b) a prompt that triggers `Read`+`Grep` tool use, (c) a prompt that triggers extended thinking. Save as fixtures.
2. Unit test `createStreamParser` against each fixture, asserting the shape of events forwarded to the handler.
3. Integration test: boot the proxy, hit `/v1/messages` with `stream: true`, diff the SSE output against a golden file.
4. Smoke test with `claude-overnight --dry-run` using `--model=claude-opus-4-7-thinking-high` (Cursor) and confirm the ticker moves.

## Links

- Consumer code: `claude-overnight/src/planner-query.ts::runPlannerQueryOnce` — exactly how Anthropic SSE events get turned into UI state and NDJSON transcripts.
- Anthropic SSE reference: https://docs.anthropic.com/en/api/messages-streaming
- Claude Agent SDK partial-message schema (search for `SDKPartialAssistantMessage` in `@anthropic-ai/claude-agent-sdk`).
