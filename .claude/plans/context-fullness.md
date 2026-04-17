# Context Fullness Indicator

## Problem

Three related gaps:
1. **Usage cap is Anthropic-only** — `usageCap` tracks Anthropic org-level rate limits, meaningless for Gemini/GPT/etc. Each provider has its own billing + rate-limit model.
2. **No context window visibility** — APIs report per-request token usage, but we never track cumulative context occupancy relative to the model's `safeContext` threshold.
3. **No token counting in cursor proxy** — the proxy is just a pass-through; token counts come from API responses themselves (`BetaUsage`), not any proxy-side helper.

## What APIs already do

Every provider returns per-request token counts in the response:
- Anthropic: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` via `BetaUsage`
- SDK result: `usage` field (type `NonNullableUsage`) + `modelUsage` (per-model breakdown with `contextWindow`)
- These are already captured at `src/swarm.ts:764-766` into `totalInputTokens` / `totalOutputTokens`

No proxy-side counting exists or is needed.

## Implementation

### Step 1: Per-agent context tracking in `src/swarm.ts`

Track cumulative input tokens per agent session (across tool turns). The `SDKResultSuccess` result already has `usage.input_tokens` per turn. Sum them per agent.

- Add `contextTokens: number` to `AgentState` in `src/types.ts`
- On each `result` event, accumulate: `agent.contextTokens += safeAdd(r.usage.input_tokens)`
- Expose `model` → `safeContext` lookup via existing `getModelCapability()`

### Step 2: Context bar rendering in `src/render.ts`

Add a second bar in `renderUsageBars()` showing context fullness:

- **X-axis**: `agent.contextTokens` vs `capability.safeContext`
- **Color zones**: green (<50% safeContext), yellow (50-80%), red (>80%)
- Render both a **current agent** bar (when detail view is open) and an **aggregate** bar showing the max context-fill among active agents
- Label: `Context  ████████░░░░  62K/100K safe`

### Step 3: Usage cap as per-provider concept

The `usageCap` concept currently only makes sense for Anthropic's org-level rate limits. For non-Claude providers, we need to either:

a) **Drop the usage bar when using non-Claude** — show only the context bar instead, since rate limits don't map across providers
b) **Keep usage bar but label it "Anthropic RL"** so it's clear it's only relevant for Claude sessions

**Decision: (b)** — keep the usage bar but clarify it's Anthropic-specific. When not using Claude, the context bar becomes the primary indicator.

### Step 4: Steering frame update

Update `renderSteeringFrame()` to also show context fullness, since the planner is also consuming context as it iterates.

## Files changed

1. `src/types.ts` — add `contextTokens` to `AgentState`
2. `src/swarm.ts` — accumulate context tokens on `result` events
3. `src/render.ts` — add context bar to `renderUsageBars()`, update `renderSteeringUsageBar()`
4. `src/models.ts` — no changes (already has `safeContext`)

## Design decisions

- **Per-agent, not global** — context fills per agent session, not across the whole swarm
- **SafeContext, not ContextWindow** — use the conservative `safeContext` threshold (40% of declared), not the full window, since that's what we've determined is actually usable
- **No proxy changes** — token counts come from API responses, no cursor-api-proxy involvement needed
