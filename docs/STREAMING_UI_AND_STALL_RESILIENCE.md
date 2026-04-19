# Streaming UI & Stall Resilience — Design

Context: during long thinking-model phases (planner, steerer, verifier, thinking-wave
agents) the TUI currently shows only a compact event list. Two problems:

1. **No resilience to provider SSE stalls.** DashScope (Qwen) and other Anthropic-
   compatible endpoints drop mid-stream under concurrent load. The SDK surfaces this
   as `Stream stalled: no content for 15000ms` and the agent dies with whatever
   partial output it had silently discarded.
2. **No live inspection.** Minutes of silent reasoning feel frozen. Users want to
   see tokens stream like Claude's native interface, and to zoom into a single
   agent's stream during the thinking wave.

This document specifies the architecture for both — they share a single seam
(the transcript on disk), so they ship together.

---

## Phase → streaming-widget matrix

| Phase                    | Model class | Duration | Agents | Stream widget              | Reason                                                          |
| ------------------------ | ----------- | -------- | ------ | -------------------------- | --------------------------------------------------------------- |
| Initial planner          | thinking    | 30s–3m   | 1      | **default pane**           | silent reasoning, user wants proof of life                      |
| Thinking wave            | thinking    | 2–10m    | N      | **expandable per-agent**   | inspect one stream, others stay in table                        |
| Wave planner             | thinking    | 20s–2m   | 1      | **default pane**           | same as initial planner                                         |
| Steerer                  | thinking    | 30s–2m   | 1      | **default pane**           | user just interacted, wants to see output                       |
| Reflection / synthesis   | thinking    | 30s–2m   | 1      | **default pane**           | silent                                                          |
| Verifier                 | thinking    | 30s–3m   | 1      | **default pane**           | silent reasoning over test results                              |
| Fallback decomposition   | thinking    | 30s–2m   | 1      | **default pane**           | infrequent, long                                                |
| Wave execution           | action      | 1–15m    | N      | **no (current events)**    | tool events already entertaining; token stream = noise          |
| Debrief                  | thinking    | <1m      | 1      | optional                   | too short to matter                                             |

**Rule:** `thinking-class model + single-stream OR explicitly focused agent → widget on`.
Action waves keep the event list.

---

## Resilience layer (below UI)

Single principle: **the NDJSON transcript is the source of truth.** Network is a
feeder; UI is a reader; retries are an executor detail.

```
┌──────────────┐  SDKMessage   ┌──────────────┐  append  ┌─────────────────┐
│  query()     │──────────────▶│  StreamSink  │─────────▶│ transcripts/... │
│ (SDK stream) │               │ (watchdog)   │          │   *.ndjson      │
└──────────────┘               └──────┬───────┘          └────────┬────────┘
                                      │ events                     │ tail
                                      ▼                            ▼
                             ┌──────────────┐            ┌──────────────┐
                             │ StallGuard   │            │ UI StreamPane│
                             │ (retry/      │            │ (read-only)  │
                             │  salvage)    │            │              │
                             └──────────────┘            └──────────────┘
```

**StreamSink** (extend `src/core/transcripts.ts`): every SDKMessage →
append to per-stream NDJSON + update `lastByteAt` + emit on event bus.

**StallGuard** (new, one per live stream):

- watchdog interval 5s; thresholds `{thinking: 30s, action: 60s, between-tool: 45s}`
- on stall → `abort()` current SDK call, then branch:
  1. **Salvage** if partial output ≥ min-useful (e.g. 300 tokens of assembled text
     for a design doc) → mark "partial", downstream consumes it.
  2. **Retry** same provider, exp-backoff `2s/8s/30s`, max 2 attempts. Resume prompt
     includes already-written content so the model continues, not restarts.
  3. **Rotate** to fallback provider (configurable per role: worker→planner, or a
     second provider entry) after retries exhausted.
  4. **Fail soft** — mark stream failed, do NOT halt wave. Circuit breaker stays
     at the wave level (per existing memory: 2 consecutive zero-change waves).
- 429/rate-limit body → longer wait, not retry loop (reuse `core/rate-limiter.ts`).
- Provider-wide stall (≥ ⌈N/2⌉ streams stall within 15s) → treat as outage,
  rotate the *rest* of the wave to fallback provider.

Where to hook:

- `src/swarm/message-handler.ts` wraps the SDK message iterator — the sink lives
  there for wave agents.
- `src/planner/query.ts` gets an analogous hook for planner / steerer / verifier
  streams.

---

## Stream widget (UI)

Keep Ink. The widget is a **fixed-height scroll buffer**, not a new screen.
Placement = same slot where `src/ui/run-body.tsx` currently renders the events
list, driven by a *view-mode* in `src/ui/store.ts`:

```
viewMode: 'events' | 'stream:planner' | 'stream:steerer' | 'stream:agent-N'
```

**Source:** `useTranscriptTail(path)` tails the NDJSON on disk via `fs.watch` +
incremental reads. This means:

- UI is always reading, never blocking execution.
- User can re-open the run later and scrub through the same files.
- Post-mortem inspection is just `cat transcripts/thinking-wave/agent-1.ndjson | jq`.

**Rendering:**

- Text deltas stream into a ring buffer (cap ~2k lines). Wrap-aware, width-reactive.
- Tool calls render as collapsible one-liners (`▸ Read(path.ts)`). Press space to
  expand args/result inline.
- Follow-tail by default; any scroll-up pauses follow; `End` or `g` resumes.
- Stall indicator in the pane header:
  `● streaming · 42 tok/s` → `◐ waiting 12s…` → `◑ retrying (2/3)…`.
- Batch re-renders at 100ms to keep Ink happy at 50+ tok/s.

**New controls** (shown only when widget is active):

- `0-9` — focus agent N's stream
- `Tab` — cycle planner / steerer / verifier when active
- `Esc` — back to global events view
- `↑/↓ PgUp/PgDn` — scroll
- `End` — follow tail
- `/` — search within buffer

---

## File layout

```
src/core/
  transcripts.ts           # extend: per-stream NDJSON writer + bus
  stall-guard.ts           # NEW: watchdog, retry, salvage policy
src/swarm/
  message-handler.ts       # wire StreamSink + StallGuard per agent
src/planner/
  query.ts                 # same wiring for planner/steerer/verifier
src/ui/
  widgets/
    stream-pane.tsx        # NEW: scroll buffer, tail, controls
    stream-status.tsx      # NEW: "streaming / waiting / retrying" chip
  hooks/
    use-transcript-tail.ts # NEW
    use-scroll-buffer.ts   # NEW
  run-body.tsx             # switch between EventList and StreamPane
  store.ts                 # add viewMode
```

`planner/query.ts` is 446 LOC — watch the 500-line cap when wiring; may need a
small split at that time.

---

## Rollout order

1. **Transcripts as source of truth.** Every stream writes NDJSON. No behavior
   change yet. Immediately unblocks post-mortem `cat`.
2. **StallGuard.** Watchdog + abort + salvage. Fixes the DashScope-stall class.
   No UI changes needed; errored agents become "partial" with saved content.
3. **Retry + provider rotation.** Layer on top of the guard.
4. **StreamPane widget.** Tail reader first, wired to planner/steerer only
   (single-stream phases). Validate Ink perf there.
5. **Per-agent focus in thinking wave.** Reuse the same widget, pointed at
   agent NDJSONs.
6. **Event-list fallback preserved.** Existing behavior is the default view-mode;
   nothing regresses.

---

## Ready-made packages — what to adopt, what to skip

Survey done 2026-04-19 against npm + ctx7. The goal is *less code to own*, not
more dependencies; anything adopted must be actively maintained and earn its
weight.

### Adopt

| Package | Version | Role | Why |
| --- | --- | --- | --- |
| `@inkjs/ui` | 2.0.0 | Spinner, ProgressBar, StatusMessage, Badge, Alert | Official Ink kit by Ink's maintainer (vadimdemedes). Replaces our ad-hoc status chips with consistent components. `StatusMessage` maps cleanly to the streaming/waiting/retrying states; `Badge` for `partial`/`failed`. Also: `Select` uses `visibleOptionCount` for viewport scrolling — same pattern we need for the stream buffer. |
| `@logdna/tail-file` | 4.0.2 | File tail for `useTranscriptTail` | Cross-platform, fault-tolerant `tail -f`. Handles rotation, truncation, and the "file not yet created" race. Better than rolling our own `fs.watch` + position tracker. |
| `p-retry` | 8.0.0 | Retry engine inside StallGuard | Sindresorhus. Exponential backoff, `AbortError` for hard-stops, `onFailedAttempt` hook for telemetry/UI. Removes ~60 LOC of hand-rolled retry logic. |

Estimated new deps: 3 packages, all small, all actively maintained. `@inkjs/ui`
pulls in `chalk` / `cli-spinners` / `figures` / `deepmerge` (already effectively
transitive via `ink` + `chalk`).

### Skip — reasoning documented so we don't re-investigate

| Package | Reason |
| --- | --- |
| `ink-scrollable` | 404 on npm — doesn't exist. |
| `ink-scroll-list` | Last publish 2019, v0.4.1, unmaintained. |
| `ink-tab` | Tabs are heavier UX than a header chip + number keys. Revisit only if multi-pane grows. |
| `ink-use-stdout-dimensions` | Ink 7 exposes dimensions natively via `useStdout()`. |
| `chokidar` | Redundant — `@logdna/tail-file` wraps watching internally. |
| `ndjson` (lib) | Split-on-`\n` + `JSON.parse` is ~5 LOC. No back-pressure needed for our volumes. |
| `assistant-ui` (ctx7 result) | React for web; wrong runtime. |
| `@meridianlabs/log-viewer` / `web-log-viewer` / similar | All web/browser log viewers, not terminal. |

### Build ourselves — no good off-the-shelf option

- **Scroll buffer / viewport widget.** No maintained Ink component exists for a
  scrollable ring-buffer log pane. Build as `src/ui/widgets/stream-pane.tsx` +
  `src/ui/hooks/use-scroll-buffer.ts`. Pattern to follow: `@inkjs/ui` Select's
  `visibleOptionCount` + internal index. Keep under 200 LOC each.
- **NDJSON transcript sink.** Extend `src/core/transcripts.ts` — trivial
  append-only writer; no library earns its place here.

---

## Design anchors

- **Disk is the bus.** If execution writes NDJSON and UI reads NDJSON, resilience
  and inspection are almost free. Don't design in-memory event buses that vanish
  on crash.
- **Widget per phase, not per model.** The decision to show the pane is a property
  of the phase's *silent reasoning duration*, not the provider. If a future
  action-model phase spends 3 minutes thinking, the same rule flips it on.
- **Partial > nothing.** Mirror the existing memory principle: never discard paid
  tokens. Salvage always runs before marking a stream errored.
