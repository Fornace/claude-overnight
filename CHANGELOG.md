# Changelog

## 1.6.0

### Free-form wave composition

The planner is no longer limited to execute/reflect/done. It can now compose any wave type — **critique**, **verify**, **user-test**, **explore**, **synthesize**, **polish** — or mix them freely. A wave can have 3 execute agents + 1 verification agent, or 2 divergent explorers, whatever the situation calls for. The old `buildReflectionTasks` is gone; reflection is just another wave the planner can compose.

- **Model per task.** Steering can assign `"worker"` or `"planner"` model to individual tasks — review/verification tasks get the planner model, implementation gets the worker.
- **Design thinking.** All planning prompts now carry a core framing: start from the user's job, the experience IS the product, build-verify-iterate, consistency over features.
- **Verification gate.** The planner cannot declare "done" until at least one verification wave has actually run the app. No more "looks good from reading the code."

### Multi-run resume

- **Multiple incomplete runs.** If several runs are unfinished, a numbered list lets you pick which to resume (single keystroke, up to 9).
- **Run history.** Press `h` at the resume prompt to see full history — time ago, cost, phase, merged branches, last status line.
- **CWD-scoped.** Runs are filtered to the current working directory, so different projects don't interfere.
- **Wave history on resume.** Session files are reloaded so the planner has full context of prior waves, not just the last state snapshot.
- **Resume steering.** Flex runs that resume with no queued tasks immediately steer to get the next wave instead of stopping.

### Resilience

- **Steering failure preserves budget.** A failed steer no longer zeroes out remaining budget — the run stays resumable with unspent sessions intact.
- **Parse failure doesn't end runs.** If the planner returns unparseable JSON on retry, it throws instead of returning `done: true`. Runs aren't accidentally marked complete.
- **Latest symlink.** `.claude-overnight/latest` always points to the active run directory for easy access.

### Internal

- `RunState.phase` simplified to `steering | capped | done` (removed `executing`, `reflecting`).
- `overheadBudgetUsed` replaces `reflectionBudgetUsed`.
- `accIn`, `accOut`, `accTools` now persisted in run state for accurate resume stats.
- `remaining` clamped to `Math.max(0, ...)` to prevent negative values.
- Completed runs clean up `verifications/` directory alongside `designs/` and `reflections/`.

## 1.5.1

### Improved cost display

- **Live overall cost.** Stats line now shows both wave cost and running total: `$0.092 / $0.45 total`. Previously showed only the current wave's cost — the accumulated cost from previous waves was only visible in the static wave header.
- **Extra usage budget bar.** When using extra usage with a dollar budget, a dedicated progress bar shows spend vs limit: `Extra ████████░░░░░░  $0.82/$2.00`. Colors shift magenta → yellow → red as the budget fills. Replaces the old inline `[EXTRA USAGE $X/$Y]` text on the usage bar.

## 1.4.0

### Auto-simplify pass

Every agent now runs a self-review pass after completing its task. The agent's session is resumed with a simplify prompt that tells it to `git diff`, check for code reuse opportunities, quality issues, and inefficiencies, then fix them directly.

- Uses the existing interrupt+resume infrastructure — no extra agent sessions consumed
- Non-fatal: if the simplify pass fails (timeout, rate limit), the task is still marked done
- Review checklist covers: existing utility reuse, redundant state/copy-paste/unnecessary abstractions, and efficiency (redundant work, missed concurrency, unbounded structures)

## 1.3.0

### Interrupt + resume for silent queries

Agents and planner queries that go silent are no longer killed immediately. Instead, they are interrupted and resumed with full conversation context via the SDK's `interrupt()` + session resume mechanism.

- **Agents**: silent for 15min → interrupt + resume with "Continue". Silent for another 30min → hard kill. Configurable via `--timeout`.
- **Planner**: silent for 15min → interrupt + resume. Silent for another 30min → hard kill.
- Uses SDK `persistSession: true` and `resume: sessionId` — the resumed query picks up with all prior tool calls, file reads, and partial work intact.

### Extra usage improvements

- **Smooth extra usage transition.** When extra usage is allowed, hitting plan limits no longer flashes "rejected" status or blocks dispatch — agents continue seamlessly into overage. Log shows "switching to extra usage" instead.
- **Extra usage budget shown in UI.** The `[EXTRA USAGE]` tag now displays spend vs budget, e.g. `[EXTRA USAGE $1.23/$5]`.
- **Fixed stale "Waiting for reset 0s" display.** Rate limit reset deadline is cleared when agents resume, and expired deadlines are no longer rendered.

### Internal

- Unified `NudgeError` class in types.ts (was duplicated as `PlannerNudgeError` + `AgentNudgeError`).
- Removed dead `rateLimitStatus` field.
- Default agent inactivity timeout raised from 5min to 15min.

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
