# Changelog

## 1.2.1

- Full progress UI during all planner phases — theme identification, orchestration, steering, and reflection now show elapsed time, cost, utilization %, and streaming text instead of bare spinners.

## 1.2.0

### Extra usage protection

- **Extra usage is blocked by default.** When your plan's rate limits are exhausted, the run stops cleanly and is resumable — no surprise bills.
- Interactive step ⑤ lets you opt in: No / Yes with $ limit / Yes unlimited.
- CLI: `--allow-extra-usage`, `--extra-usage-budget=N`.
- Overage detection via SDK `isUsingOverage` flag — immediately stops dispatch when detected and not allowed.

### Live controls during execution

- Press `b` to change remaining budget, `t` to change usage cap, `q` to stop (twice to force quit).
- Changes apply between waves — active agents finish their current task.

### Multi-window usage display

- Usage bar cycles through all rate limit windows (5h, 7d, 7d opus, 7d sonnet, overage) every 3 seconds.
- Usage info (cost, utilization %) now shown during all phases — thinking, orchestration, steering, and execution.

### Per-wave cost tracking

- Wave headers now show cumulative spend: `◆ Wave 2 · 12 tasks · 38 remaining · $14.20 spent`.

### Internal

- Consolidated overage enforcement into `capForOverage()` — consistent behavior between throttle and rate limit event handler.
- Planner rate limit state resets per query (no more stale cumulative cost across waves).
- Early exit in `throttle()` prevents duplicate log messages from multiple workers.
- Live config uses dirty flag instead of fragile value comparison.

## 1.1.0

- Updated README with resilience documentation.

## 1.0.3

- Any premature stop is resumable (not just capped — also crashed, aborted, steering failures).
- `objectiveComplete` flag: only true when steering explicitly says "done".

## 1.0.2

- Capped runs are resumable with full context preserved.
- Richer run history at startup (merged count, status line).
- Orphaned design doc detection and reuse.

## 1.0.1

- Resilient orchestration: file-based task output, contextful retry, truncated JSON salvage.
- Rate limit cooldown between thinking and orchestration phases.
- Diagnostic logging on parse failures.

## 1.0.0

- Initial release.
- Interactive mode: objective → budget → model → usage cap → theme review → autonomous execution.
- Flex mode: adaptive multi-wave planning with thinking, orchestration, steering, and reflection.
- Three-layer context: living status, milestones, evolving goal.
- Per-run folders, cross-run knowledge inheritance, preserved run history.
- Run state persistence, crash recovery, resume.
- Git worktree isolation, auto-commit, auto-merge.
- Rate limit handling: hard block wait, soft throttle, usage cap, planner retries with backoff.
