// Narrow, typed view of the streaming-event payloads we actually consume
// from `@anthropic-ai/claude-agent-sdk`. The SDK types `event` as the
// upstream Anthropic `BetaRawMessageStreamEvent`, which we don't want to
// import directly (claude-agent-sdk re-exports nothing from there, and
// pulling `@anthropic-ai/sdk` in just for one type would be overreach).
//
// Cross-cutting note: `src/swarm/message-handler.ts` parses the same
// shape with `as` casts. Promoting these to `src/core/sdk-events.ts`
// is logged in `_tmp/simplify-cross-cutting.md`.
export {};
