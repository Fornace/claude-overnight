# Changelog

## 1.24.7

- **Cursor proxy:** When auto-starting the bundled proxy, mirror the bridge API key into **`CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`** for the child process when those are unset (same token the Cursor agent expects; `CURSOR_BRIDGE_API_KEY` alone only gated HTTP).
- **Dependency:** `cursor-composer-in-claude` **0.7.8** — bridge key fallback for agent token in `loadBridgeConfig` (headless / macOS keychain avoidance).
- **Install:** Publish **`cursor-composer-in-claude@0.7.8`** to npm before a clean `npm ci` / install from the registry; until then use `npm install ../cursor-composer-in-claude` from a sibling checkout or install from the local package tarball.

## 1.24.6

- **Cursor proxy:** Only kill **TCP listeners** on the proxy port (`lsof -sTCP:LISTEN`), not clients, so restarting a stale proxy no longer SIGKILLs the claude-overnight process.
- **Bundled proxy:** Replace any listener whose `/health` version is missing or differs from `node_modules/cursor-composer-in-claude`. `ensureCursorProxyRunning(..., true)` now force-restarts. Setup and user messages use the bundled `node …/cli.js` path and `npm install` in this package — no `npx` / global install for the proxy.

## 1.24.5

- **Dependency:** `cursor-composer-in-claude` **0.7.7** (exact pin). Proxy startup logs + forced `CI`; overnight restarts a stale proxy on `:8765` when its `/health` version differs from the bundled package, and forces `CI` / `CURSOR_SKIP_KEYCHAIN` on Cursor provider env.

## 1.24.4

- **Dependency:** `cursor-composer-in-claude` **^0.7.6** (proxy forces `CI=true` on every agent spawn alongside keychain skip — fixes macOS keychain prompts when the proxy was not started with `CI`).

## 1.17.0

### Three-layer review system

Agents review their own work, waves get reviewed, and the final diff gets a quality gate  -- all wired through the SDK's session resume (continue) mechanism so no extra context is needed.

- **Layer 1  -- Per-agent self-review (always-on).** Enhanced the existing simplify pass that runs after every agent finishes. The review prompt now covers specific checks: missed reuse (existing utilities, hand-rolled patterns vs built-ins), quality (redundant state, copy-paste variations, leaky abstractions, stringly-typed code, narrative comments), and efficiency (N+1 patterns, hot-path bloat, TOCTOU anti-patterns, memory leaks, recurring no-op updates). Runs via **session resume**  -- the same agent session continues with a follow-up prompt, keeping the agent's full context from its task. No initial context bloat.
- **Layer 2  -- Post-wave review wave.** After each wave (flex mode, budget remaining, wave > 0), a dedicated review agent inspects the consolidated diff for issues individual agents blind-spotted. Runs as a single-agent swarm wave. Gated  -- skips on abort/cap/first wave.
- **Layer 3  -- Post-run final review gate.** Before the final summary, a comprehensive review runs against the full `git diff main`. Checks architecture coherence, consistency with existing patterns, build integrity, and test pass. The last quality gate before the diff lands.
- **Continue mechanism.** All per-agent reviews use the SDK's `resume` parameter  -- the agent session picks up where it left off with its full conversation context intact. The review prompt is appended as a follow-up, not prepended to the initial instruction. This keeps the initial task prompt lean and lets the agent's own context do the heavy lifting.

## 1.16.16

### Playwright parallel testing quicksheet + headless by default

- **`QUICKSHEET_PLAYWRIGHT.md`**  -- standalone reference with three isolation tiers: `--isolated` for lock-free parallel runs, per-agent `userDataDir` for saved logins, and headed fallback only when anti-bot detection (CAPTCHA, Cloudflare) requires visible browser interaction. Shipped via npm (`files[]` includes `plugins/` + quicksheet).
- **Headless mode by default.** Headed browser launches steal macOS focus during long runs. All MCP config examples now use `--headless`  -- drop it only when you hit anti-bot walls.
- **SKILL.md Playwright section.** The claude-overnight skill now teaches agents the isolation rules at a glance and points to the full quicksheet.
- **Context7 (ctx7) integration.** Quickstart commands for fetching current Playwright docs, with a pre-flight auth check and graceful fallback when unauthenticated.

## 1.16.4

### Merge healing, silent-data-loss fixes, and noise reduction

Three root-cause fixes for the "swarm looks busy but nothing merges" class of issues.

- **Hook-rejected commits no longer destroy work.** `autoCommit` used to run `git commit` once, catch the error, log "git commit failed", and return 0. In hook-gated projects (husky, lint-staged, pre-commit) the error was almost always a hook rejection on work-in-progress code  -- and the uncommitted changes would then get wiped when the worktree was cleaned up. The commit path now retries with `--no-verify` if the first attempt fails for any reason other than "nothing to commit", and the bypass is logged so you see it happened. This is swarm scaffolding, not a user-authored commit  -- running the user's quality gates on every intermediate agent WIP is actively harmful to the swarm mechanism.
- **Real work measurement.** `filesChanged` was computed as `git diff --name-only baseRef..HEAD` AFTER the commit  -- so if the commit failed (see above), the count was 0 even when the agent had modified dozens of files. The count is now taken BEFORE the commit attempt using `git diff baseRef --` + `git ls-files --others --exclude-standard`, which captures tracked + unstaged + untracked work. If the authoritative post-commit count is 0 but the pre-count was not, we now log `"N file(s) touched but did NOT land on branch  -- check hooks / gitignore / absolute paths"` instead of silently reporting zero.
- **3rd-tier merge healer.** `mergeAllBranches` used to give up after `git merge` and `git merge -X theirs` both failed, leaving long lists of `✗ swarm/task-N (conflict  -- preserved for manual merge)` even though the branch content was perfectly landable. `-X theirs` can't resolve rename/delete, modify/delete, or rename/rename. A new `forceMergeOverlay()` walks `git diff --name-status base..branch` and applies each change directly: checkout-from-branch + add for modify/add/rename, `git rm` for deletes, then commits. Trades merge-graph fidelity for "your changes actually land"  -- the right call for an autonomous swarm. Wired into both `mergeAllBranches` (wave merges) and `autoMergeBranches` (resume path).
- **Auto-`noWorktree` for verify/audit/user-test tasks.** The planner and steering prompts generate plenty of read-only tasks  -- "Verify SWR cache invalidation", "Audit error handling"  -- which were getting full worktrees and then finishing with `0 files changed`, polluting the log. `postProcess` now detects tasks whose prompt starts with a read-only verb and sets `noWorktree: true` before dispatch. They run in the real project directory (with env files and local config), don't create a branch, and don't show up as 0-file noise.

## 1.16.0

### Custom providers  -- route executors to Qwen, OpenRouter, or any Anthropic-compatible endpoint

The planner can stay on Opus while executors run on a cheaper model. Same run, two different providers, per-call env routing  -- no global shell shenanigans, no proxy daemon.

- **"Other…" in the model picker.** Planner (④) and executor (⑤) are now picked separately. Each picker lists Anthropic models + any saved custom providers + an `Other…` entry that walks you through adding a new one (display name, base URL, model id, API key source). Saved once, available in every repo.
- **User-level key store.** Providers live in `~/.claude/claude-overnight/providers.json` (mode 0600). Two key sources: paste inline (stored plaintext in the 0600 file) or reference an env var (`CO_KEY_QWEN` etc.  -- nothing written to disk). `ANTHROPIC_API_KEY` is explicitly cleared for custom-provider subprocesses so the SDK uses `ANTHROPIC_AUTH_TOKEN` as a bearer.
- **Per-call env routing.** Each `query()` gets its own `env` override built from `process.env` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. Planner queries (planning, steering, thinking, in-run asks) hit the planner provider; executor queries hit the executor provider. One shared resolver (`buildEnvResolver`) drives both via `setPlannerEnvResolver` (module-global for `planner-query.ts`) and `SwarmConfig.envForModel` (per-task for `swarm.ts`).
- **Pre-flight validation.** Before the swarm starts, each custom provider gets a 1-turn ping with a hard timeout and interrupt. A bad key fails fast with `✗ planner preflight failed: ...` instead of N scattered auth errors mid-run.
- **Resume rehydration + orphan detection.** Provider ids are persisted in `run.json` (`workerProviderId`, `plannerProviderId`) and re-resolved from the user-level store on resume. If the store no longer has them, resume aborts with a clear message naming the missing id.
- **Base URL normalization.** Trailing slashes and accidentally-included `/v1/messages` / `/messages` suffixes are stripped on entry so pasting from docs just works.
- **`--model=<custom>` auto-resolve.** In non-interactive mode, `--model=qwen3-coder-plus` (or any saved provider's model id or short id) looks up the provider automatically and routes through it. No separate `--provider` flag needed.
- **Fallback when the Anthropic model list is unavailable.** If `fetchModels()` times out or fails, the picker still shows saved providers, an "Other…" entry, and a synthetic `claude-sonnet-4-6` default so you're never trapped.

Existing Anthropic-only runs keep working unchanged  -- new provider fields on `RunState` are optional, and the default resolver is a no-op when nothing custom is configured.

## 1.15.0

### Rate-limit transparency + `[r]` retry-now

You shouldn't have to ask why the swarm is cooling down  -- the UI now says it out loud, and you can unblock it from the keyboard.

- **Named window in the usage bar.** "Cooling down  -- 1 worker(s) waiting" is gone. The bar now reads e.g. `Anthropic 5h limit hit  -- resets in 34m 12s (1 waiting)`, pulled from the most-constraining `rateLimitWindow` (rejected first, else highest utilization). No more guessing which window is blocking you.
- **First-hit explanation.** The first time Anthropic rejects a request, one system event prints: `5h window is full  -- plan-level Anthropic limit, not a claude-overnight cap. Press [r] to retry now, [c] to lower concurrency, or wait for reset.` So you know the difference between *our* soft cap and *their* hard wall.
- **Window tags in every rate-limit log line.** Both the pre-task throttle and the per-agent 429-retry paths now tag logs like `Rate limited (5h window)  -- waiting 60s ([r] to retry now)`.
- **`[r] retry-now` hotkey.** When workers are sleeping on a rate limit, the hotkey row shows `[r] retry-now`. Pressing it clears `rateLimitResetsAt` and wakes every pending sleeper via a new cancellable `rateLimitSleep()`. The API may reject again, but you get to decide *when* instead of staring at a timer  -- useful when the server-side reset already happened but our cached timestamp is stale.

## 1.14.1

### Instant startup splash  -- no more black terminal

Launching `claude-overnight` used to leave the terminal black for 10+ seconds while node bootstrapped the Agent SDK module graph (worse on projects with a lot of saved runs). That dead gap is gone: a tiny bin wrapper (`dist/bin.js`) now prints a braille-spinner splash the instant node is ready, then dynamically imports the real entrypoint. The splash is stopped the moment `index.ts` is about to print its header, so there's no flicker into interactive prompts. `-h` / `-v` and non-TTY pipelines skip the splash entirely.

### Resume → Edit no longer prints a timeout warning mid-flow

Picking `[E]dit` on a resumed run used to call `fetchModels(5_000)` _after_ you'd already chosen Edit, and on slow networks it would dump `Model fetch timed out  -- continuing with defaults` into the middle of the wizard. Now the fetch is kicked off in the background as soon as the settings box renders (up to 20 s), with a `loading models...` spinner shown only if the user actually picks Edit and the request hasn't finished yet. The timeout warning is silenced  -- the fallback text prompt with the current value as default already handles it gracefully.

## 1.14.0

### Resume with new settings  -- review and edit before the run starts

Until now, resume was all-or-nothing: whatever model, concurrency, usage cap, and overage budget the run was saved with, that's what came back. No way to drop a `sonnet[1m]` run to regular `sonnet` after hitting the 7-day window, no way to halve concurrency, no way to tighten the extra-usage cap  -- you had to quit, edit `run.json` by hand, or restart from scratch.

Picking `[R]esume` from the unfinished-run picker now shows a settings box and a short menu:

```
  Resume settings
  ────────────────────────────────────────
  model      sonnet[1m] (sonnet)
  remaining  133 sessions
  concur     10
  usage cap  unlimited
  extra      unlimited

  R esume  │  E dit  │  Q uit
```

Hitting `E` walks a 5-step wizard (model picker · remaining sessions · concurrency · usage cap % · extra usage). Every field defaults to the saved value  -- empty-enter keeps it. The new settings are persisted to `run.json` before the run starts, so a crash during the first wave doesn't throw them away.

CLI flags are also honored on resume: `claude-overnight --model=claude-sonnet-4-6 --usage-cap=75 --extra-usage-budget=30` pre-fills those fields before the review prompt. Previously these flags were silently dropped on resume.

Supported overrides: `--model`, `--concurrency`, `--budget` (treated as new remaining count), `--usage-cap`, `--extra-usage-budget`, `--allow-extra-usage`, `--perm`. Structural fields (worktrees, merge strategy) stay frozen  -- changing them mid-run would conflict with existing worktree state.

### `[e]` extra usage cap  -- live at runtime

New hotkey next to `[b] budget`, `[t] cap`, `[c] conc`:

```
[b] budget  [t] cap  [c] conc  [e] extra  [p] pause  [s] steer  [?] ask  [q] stop
```

Press `[e]`, type a new `$` cap, hit enter. The change takes effect immediately on the running wave and persists across wave boundaries via `liveConfig`. If the new cap is already below current overage spend, the swarm caps out cleanly instead of continuing.

`0` means "stop on the first overage dollar"  -- useful for "burn through plan quota but don't pay a cent extra". A positive number sets a dollar cap. There's no runtime path to "unlimited" from this hotkey  -- use the resume override for that (or just ignore `[e]`).

The `[t] threshold` label is now `[t] cap` to fit the extra column without wrapping narrow terminals.

## 1.13.0

### Budget exhausted? Just hit enter to keep going

When a run hit its session budget before finishing, the only option was to exit and restart the resume picker. Now the steering planner emits `estimatedSessionsRemaining` every wave  -- an honest estimate of how many more sessions it would take to reach "amazing", factoring in follow-up fixes, polish, and verification. At exhaustion, instead of finalizing, the run surfaces that estimate and prompts:

```
Budget exhausted  -- run not yet complete.
Planner estimate: 12 sessions to complete (~$7.68 at $0.64/session)
Continue with 20 more sessions (~$12.80)? Everything stays the same  -- just hit enter.
Y  C  N
```

Enter accepts the suggestion (estimate × 1.3 rounded up to the nearest 5, minimum 10), `C` types a custom number, `N` finalizes. On accept, the wave loop re-enters in place with the same model, concurrency, permissions, worktrees, usage cap, and objective  -- no restart, no resume picker, no re-planning. If the planner didn't produce an estimate (rare), the suggestion falls back to 20% of the original budget with a minimum of 10.

Skipped automatically when the stop was a cost cap (`--usage-cap` / `--extra-usage-budget`) rather than session count  -- extending those needs a different knob.

## 1.11.12

### Rate-limit rejections now retry instead of silently no-op'ing

Symptom from a live `analisi-conti` run: agents 39/40/41 finishing in 7–9s with `Rate: rejected`, `0 tools`, `0 files changed`, then logged as "Agent N done" while internally being marked as failed and having their budget burned. The 1.11.3-5 rate-limit fixes only handled the case where the SDK *throws* a 429  -- but the SDK's preferred path is to send a `rate_limit_event` message with `status: "rejected"` and then close the stream cleanly. No exception → the retry branch never ran → agents counted as failed, prompts lost, budget gone.

Three coordinated fixes in `swarm.ts`:

- **Rejection events now throw** from inside `handleMsg`. When `rate_limit_event` arrives with `status: "rejected"`, we set `rateLimitResetsAt` to a 60s fallback if the SDK didn't provide one (it usually doesn't on rejection), then throw `Error("rate limit rejected  -- retrying")`. The throw bubbles through the `for await` → caught by the existing rate-limit retry branch in `runAgent` → waits and retries without burning the attempt budget. The throttle gate also re-arms so subsequent dispatches in the same wave don't pile-on.
- **`agentQuery.close()` runs in the finally** block of `runOnce`, not just on natural exit. Previously, throwing out of the for-await left the underlying claude process orphaned.
- **`agentSummary` no longer hardcodes "done"** in the log string. Errored agents now log `Agent N errored: …` so the visible state matches the internal state.

Plus one fix in `run.ts`:

- **Never-started tasks survive abort/cap**. When a wave is interrupted (Ctrl+C, overage cap, crash), the queue is cleared and any unprocessed tasks were silently lost  -- `saveRunState` always wrote `currentTasks: []`. Now we compute `neverStarted = currentTasks - swarm.agents.attempted` and persist that. On resume, the wave loop picks them up and runs them as the next wave instead of relying on steering to re-derive them from history. Budget arithmetic stays correct because never-started tasks were never decremented from `remaining` in the first place.

Regression tests in `rate-limit-rejection.test.ts` cover the throw, the fallback `resetsAt`, the SDK-provided `resetsAt` passthrough, the non-rejected status passthrough, and the `agentSummary` verb. Existing 93 tests still green.

## 1.11.11

### Pasting multi-line text no longer submits on the first newline

Every text-input prompt in the CLI  -- startup objective, budget/concurrency/model, "What should change?" feedback during review, "Ask about the plan", and the in-run steer/ask modes  -- now uses bracketed paste mode (`\x1B[?2004h`). Pasted content is wrapped by the terminal in `\x1B[200~…\x1B[201~` so pasted newlines can be distinguished from typed Enter. Before this fix, pasting any multi-line text would fire submit on the first `\n` and the remaining lines would leak into the terminal as stray commands.

While editing, large or multi-line pastes render as a dim `[Pasted +N lines]` placeholder (matching Claude Code's behavior), keeping the prompt readable; the full text is substituted back in on submit. Backspace removes a paste block atomically instead of one char at a time.

Implemented in `cli.ts` (`splitPaste`, segment helpers, and a new raw-mode `ask()`) and wired through the `RunDisplay` key handler in `ui.ts` so `budget`/`threshold`/`steer`/`ask` modes all share the same segment buffer. Numeric modes sanitize pasted content to `[0-9.]` so stray paste markers can't corrupt the value.

## 1.11.10

### Agent self-commits no longer orphan branches

Seen live in a 53-task payme run: 15/53 branches landed with real commits on disk but `filesChanged: 0` in `run.json`, got filtered out of the merge gate, and silently orphaned. All 15 were tasks where the agent chose to `git commit` its own work (despite the preamble telling it not to  -- some agents prefer owning their git hygiene, and we should accommodate that).

Root cause: `autoCommit()` in `merge.ts` measured work by counting `git status --porcelain` lines in the worktree. Once the agent committed its changes, the worktree was clean at measurement time → 0 lines → `filesChanged=0` → the merge gate in `swarm.ts` (`filter(a => (a.filesChanged ?? 0) > 0)`) dropped the branch → `mergeAllBranches` never saw it → branch and commits survived on disk but were neither merged nor cleaned up.

The smoking gun was consistent: 15 branches with `status: "unmerged"` and `filesChanged: 0` whose `git log main..swarm/task-N` each showed exactly one real commit. The filesChanged number and the branch state disagreed  -- the number was always the wrong one.

Fix: make filesChanged the *result* of measurement, not the *cause* of inclusion. `autoCommit` now captures `baseRef` (the commit the worktree was branched from) at worktree-add time, auto-commits any still-dirty files if present, then measures `git diff --name-only <baseRef>..HEAD` as the single source of truth. This is correct regardless of who made the commits  -- agent, autoCommit, or both.

Secondary fixes so old orphans can still be recovered after upgrading:

- `cleanStaleWorktrees` now uses `git branch -d` (safe) instead of `-D` (force). Already-merged branches still get cleaned; branches with unmerged commits survive. A separate log line reports how many orphans were kept so you know they exist.
- `autoMergeBranches` (the resume-time recovery path in `state.ts`) no longer gates on `filesChanged > 0`  -- it feeds every `status: "unmerged"` branch to git and lets git decide. This catches pre-1.11.10 BranchRecords that have the wrong count baked in.

Regression test in `auto-commit-self-commit.test.ts` simulates the exact scenario with a real git worktree: agent commits, worktree stays clean, autoCommit must still report the right count. Also covers the dirty-only, mixed, noop, and missing-baseRef cases.

## 1.11.9

### macOS `/private` tmpdir bug broke stale-worktree cleanup

Seen live resuming a 54-task plan: the first wave's attempt to create `swarm/task-0` failed with `branch already checked out` because a worktree from a prior dead attempt was still registered in git. `cleanStaleWorktrees()` in `merge.ts` was supposed to clean that up on every run start, but its matcher was broken on macOS  -- it gated stale detection on `wpath.startsWith(os.tmpdir())`, and `os.tmpdir()` returns `/var/folders/…` while `git worktree list --porcelain` returns `/private/var/folders/…` (the realpath-resolved path). The `startsWith` check never matched, stale worktrees accumulated forever, and the first retry of any task branch would always fail.

Fix: drop the `startsWith(tmp)` gate. The `/claude-overnight-` substring is unambiguous enough on its own  -- nothing else in a repo uses that prefix. Now matches both `/var/folders/...` and `/private/var/folders/...` paths, plus Linux `/tmp/...`.

### Resume now loads `tasks.json` whenever `currentTasks` is empty

Planning-phase resume in 1.11.7 only fired if `phase === "planning"`. But `saveRunState` always writes `currentTasks: []`  -- so a `stopped` or `capped` run being resumed would have executed a zero-task wave and done nothing. Now the resume path in `index.ts` falls back to `salvageFromFile()` whenever `currentTasks` is empty on resume, regardless of phase, and reports `Resuming <phase> run · N tasks loaded from tasks.json` when it does.

## 1.11.8

### Pre-1.11.7 orphaned plans are now auto-recovered at startup

1.11.7 made future plan-phase runs resumable by saving an early `run.json`. But runs that died *before* the upgrade still had no `run.json` on disk, so `findIncompleteRuns` couldn't see them  -- they remained stuck even after upgrading.

1.11.8 adds `backfillOrphanedPlans()` in `state.ts`. On every startup, it scans `.claude-overnight/runs/` for directories that have `tasks.json` but no `run.json`, parses the dir name for the original timestamp, counts tasks for budget, and writes a synthetic `run.json` with `phase: "planning"` using conservative defaults (opus, bypassPermissions, worktrees+yolo, `flex: false`, concurrency 5). The original objective is lost to time, so it's recorded as `(recovered pre-1.11.7 plan · N tasks)`.

After backfill, the run appears in the normal resume picker and can be resumed with one keystroke  -- it jumps straight to `executeRun` at wave 0 using the tasks that were already on disk. Idempotent: runs with existing `run.json` are skipped. Logged as `↻ Recovered N orphaned plan(s) from disk` when something was actually backfilled.

Closes the loop for anyone upgrading mid-incident with stuck plans.

## 1.11.7

### Plan-phase resilience: salvage + visible resume

Before 1.11.7 a plan-phase failure was a total loss  -- paid orchestration that successfully wrote `tasks.json` could die at "Planning failed" with no way to see or recover the run. Two independent fixes:

**Salvage on-disk `tasks.json` when the planner query dies.** Concrete failure seen in the wild: a 160-session flex run spent ~2 hours in orchestrate on Opus, the agent successfully wrote all 54 tasks to `tasks.json` via its Write tool, then the query-level retry loop exhausted with `Planner query failed after retries` (silent-nudge/resume cycle on a deep thinking agent). `extractTaskJson` was never reached, so its file-read fallback never ran, and the run died at "Planning failed"  -- losing the paid orchestration that was already committed to disk.

`planTasks()` and `orchestrate()` now wrap `runPlannerQuery` in a try/catch that calls a new `salvageFromFile()` helper. If the agent already wrote a valid `{tasks: [...]}` to `outFile`, those tasks are post-processed and returned instead of letting the error propagate. A `Planner errored (<reason>)  -- salvaged N tasks from <path>` event is logged so you can see it happened. If the file is missing, malformed, or empty, the original error still re-throws  -- no masking.

**Plan-phase runs are now visible to the resume picker.** Previously `run.json` was only written from inside `executeRun` (after a wave completed), so a run that died during planning left no state at all and vanished from `findIncompleteRuns`. Now:

- `RunState.phase` has a new `"planning"` variant.
- An initial `run.json` with `phase: "planning"` is written right after `createRunDir()`, before the plan phase runs.
- `findIncompleteRuns` surfaces planning-phase runs if (and only if) `tasks.json` exists on disk  -- i.e. orchestrate made it far enough for you to actually resume.
- The resume picker shows them with a distinct line: `plan ready · N tasks · budget B · <ago> · not yet executing`.
- Picking one loads the tasks via `salvageFromFile()` and jumps straight to `executeRun` at wave 0. No re-planning, no re-paying for orchestration.

Together these two fixes close the loop: if orchestrate dies mid-query, salvage recovers the tasks; if the binary dies entirely, the run is still visible in the picker and one keystroke away from resumption.

## 1.11.6

### Durable run history: `claude-overnight.log.md`

The `.claude-overnight/` directory is ephemeral (and often gitignored), so once it's cleaned up the original objective, start time, and outcome of past runs are lost. 1.11.6 adds a small, committed, append-only log that survives cleanup.

- **On run start**, a block is appended to `claude-overnight.log.md` at the repo root with the run ID, objective, model, budget, flex flag, usage cap, and branch. Status is marked `running`.
- **On run end**, the same block is updated in place with finished timestamp, elapsed, cost, tasks done/failed, wave count, and outcome (`✓ done`, `⊘ capped`, `⊘ stopped`).
- **Merge-friendly.** Each block is keyed by run ID (the run dir basename), so concurrent runs on different machines never collide. Two teammates running in parallel get two separate blocks.
- **Filename chosen deliberately**  -- no dot prefix  -- so a `.claude-overnight` gitignore pattern (with or without trailing slash) never accidentally ignores it.

Recover the objective of a past run: just open `claude-overnight.log.md` and find the matching run ID. No more "what was my prompt" archaeology through swarm/task-* branches.

## 1.11.5

### Rate limits: truly wait forever instead of stopping

1.11.3/1.11.4 still stopped on plan-level rate limits. Now rate limits never kill a run  -- workers wait as long as needed and resume.

- **Throttle loops until clear.** Instead of waiting once (60s) and proceeding, `throttle()` now loops  -- re-checking the blocking condition after each wait. If still blocked, waits again with escalating intervals (1m → 3m → 5m max). Only breaks the loop when the rate limit actually clears.
- **Rate-limit errors don't burn retries.** When an agent throws a 429 / "rate limit" error, the worker waits 2 minutes (or until `rateLimitResetsAt`), then retries the same task without decrementing the retry counter. Only non-rate-limit transient errors count against retries.
- **`cappedOut` is budget-only.** The only path to `cappedOut = true` is `extraUsageBudget` exhaustion. Plan-level overage blocks and `usageCap` hits are always wait-and-resume.

## 1.11.3

### Rate limit: wait and resume instead of quitting

The usage cap (`--usage-cap`) was killing all remaining work when utilization hit the threshold. Now it waits for the rate limit window to cool down and resumes dispatching  -- the core promise.

- **Wait, don't quit.** When utilization reaches the cap, workers sleep until the rate limit resets (or 60s fallback), then re-dispatch. `cappedOut` is now only set for genuine hard stops (extra usage blocked, extra usage budget exceeded).
- **Self-regulating concurrency.** Active agents finish naturally while workers wait. As agents complete, concurrency drops to zero. After cooldown, workers wake one-by-one and get fresh utilization from rate limit events. If still hot, they wait again.
- **COOLING phase.** UI shows `COOLING` tag and `Cooling down  -- N worker(s) waiting` on the usage bar when workers are paused for rate limits.
- **Paused counter on hard rejections too.** Both cap-wait and rejection-wait now increment `rateLimitPaused` so the UI always reflects blocked workers.

## 1.11.0

### Restored interactive options, CLI flags, worktree resilience

The interactive flow lost its worktree, merge strategy, and permission prompts back in 0.2.0. They're back, plus concurrency is now user-controlled, and every option is also available as a CLI flag.

- **Interactive flow expanded to 8 steps.** ① Objective ② Budget ③ Max concurrency ④ Worker model ⑤ Usage cap ⑥ Extra usage ⑦ Permissions (auto / bypass all / prompt each) ⑧ Git isolation (worktrees+yolo / worktrees+branch / no worktrees). Steps ⑦ and ⑧ are skipped when CLI flags preset them.
- **Max concurrency prompt.** Was hardcoded to `min(5, budget)`. Now ③ asks for max concurrency  -- the planner decides how many agents are safe per wave, up to this limit.
- **Chat on themes review.** The themes screen (pre-thinking) now has `c` for chat, same as the task review screen. Ask questions about themes before committing to thinking agents.
- **New CLI flags.** `--worktrees` / `--no-worktrees` (force on/off), `--merge=yolo|branch`, `--perm=auto|bypassPermissions|default`, `--yolo` (shorthand for `--perm=bypassPermissions --no-worktrees`). All flags work in both interactive and non-interactive modes  -- in interactive mode they skip the corresponding prompt.
- **Worktree creation resilience.** When `git worktree add` fails, the agent now force-deletes the conflicting branch, prunes, and retries once. If the retry still fails, the agent runs without isolation instead of erroring out. Previously, stale `swarm/task-*` branches from crashed runs caused immediate agent errors with no recovery.
- **`[f] fix` hotkey.** During a wave, press `f` to re-queue all errored agents' tasks back into the active worker pool. Shown in the hotkey bar when there are failed agents and active workers that can pick them up.
- **`requeueFailed()` on Swarm.** New method resets errored agents to pending and pushes their tasks back into the queue, decrementing the failed counter.

## 1.10.0

### Steer and ask  -- user channel into an autonomous run

Previously a running claude-overnight was fully autonomous after the Run button: no way to nudge direction or ask the planner a question mid-flight. Now there's a safe, non-disruptive channel for both.

- **Steer  -- queue directives for the next wave.** Press `s` during execute or steering to open a text input. On Enter the directive is written to `.claude-overnight/latest/steer-inbox/` as its own timestamped file. The next successful steering call reads the inbox as `memory.userGuidance`, injects it at the top of the steering prompt as **USER DIRECTIVES  -- highest priority** (overrides prior status/goal assumptions), and the files are moved atomically into `steer-inbox/processed/wave-N/` so each directive applies exactly once. Running agents are never interrupted.
- **File-based inbox works without a TTY.** Anything dropped into `steer-inbox/*.md` from another shell (or an `echo` under `nohup`) is picked up by the next steering cycle. Hotkeys are the convenience, the inbox is the contract.
- **Ask  -- non-blocking planner side query.** Press `?` during execute to ask the planner a question. A compact `RunMemory` blob (objective, goal, status, latest verification/reflections, wave count) plus the question is sent to `runPlannerQuery`; the answer streams into a new `--- Ask ---` panel below the main frame. Agents keep running. Cost is billed to the run budget via the same delta pattern as steering. Disabled during the steering phase to avoid planner-call contention.
- **Steering view enrichment.** The steering frame now shows the objective, the last wave summary (done/failed/running counts + the first few task prompts), and the current status block, in addition to a dedicated planner-activity event log. Ephemeral ticker heartbeat and persistent scrollback are now separate: `PlannerLog` callbacks carry a `kind: "status" | "event"` so status ticks update the bottom line while tool uses, retries, and nudges append to the scrollback.
- **Hotkey hint row.** Execute: `[b] budget  [t] threshold  [s] steer  [?] ask  [q] stop`. Steering: `[b] budget  [s] steer  [q] stop`. A `✎ N steer queued` chip appears when the inbox is non-empty.
- **Applied directives recorded.** Each `steering/wave-N-attempt-M.json` now includes the `appliedGuidance` string when user directives were consumed, so post-run audits show exactly where the user intervened.

## 1.9.1

### Crash fix + budget accounting

A resumed run crashed with `require is not defined` right after merging unmerged branches. Turned out `isGitRepo` was using a CommonJS `require("child_process")` inside an ESM package, and `validateGitRepo` hit that path on every resume with worktrees enabled.

- **ESM require crash.** `src/cli.ts` now imports `execSync` statically at the top instead of `require`-ing it inside `isGitRepo`.
- **Resume remaining ignored failed sessions.** The resume path computed `budget - accCompleted` and ignored `accFailed`, so every failed session in the original run handed back an extra session on resume. Now uses the saved `remaining` directly.
- **Floor check refunded thinking sessions.** The per-wave floor `budget - accCompleted - accFailed` didn't know about thinking sessions, so the first wave after thinking always inflated `remaining` by `thinkingUsed`. Floor now subtracts `thinkingUsed` too.
- **`identifyThemes` ran in the wrong directory.** It hardcoded `process.cwd()` instead of the project cwd, so theme analysis ran in whatever directory the CLI was launched from  -- wrong when a task file specified a different `cwd`. Now takes `cwd` as a parameter.
- **Dynamic import removed.** `identifyThemes` was doing `(await import("./planner-query.js")).attemptJsonParse(...)` for a module already statically imported. Replaced with a normal import.
- **`formatTimeAgo` NaN guard.** A run state missing `startedAt` would render "NaNd ago" in the resume box; now returns "unknown".

## 1.8.4

### Done-blocked fix, steering diagnostics, accurate exit messages

The steerer could say "done" but the done-blocked gate (requiring a verification wave) would reject it 3 times, exhaust the steering retry budget, and exit showing "BUDGET EXHAUSTED"  -- even with 135 of 200 sessions remaining. Runs stopped for no visible reason with no way to debug.

- **Auto-verification on done-blocked.** When the steerer says "done" but no verification wave has run, the system auto-composes a verification wave instead of retrying the same steering call that will say "done" again. After verification, the steerer can assess real results.
- **Steering reasoning saved to disk.** Every steering decision writes `steering/wave-N-attempt-M.json` with `done`, `waveKind`, `reasoning`, `taskCount`, `statusUpdate`, and `goalUpdate`. No more invisible decisions.
- **`reasoning` and `statusUpdate` required in schema.** The structured output schema now enforces these fields so the model can't skip them.
- **Accurate exit messages.** "BUDGET EXHAUSTED" only when budget is actually zero. New labels: "RATE LIMITED" (usage cap or extra usage budget hit), "INTERRUPTED" (SIGINT/abort), "STOPPED" (other exits). Sessions line shows remaining count.
- **45-minute wall-clock limit on planner calls.** Safety net against planner sessions that stay alive but make no real progress due to rate limits. The nudge/timeout mechanism only detected silence  -- a rate-limited session producing occasional file reads could run for hours.

## 1.8.2

### Structured output schemas + steering retry

Steering parse failures silently killed runs. The retry logic existed but was dead code, and failed steers showed a misleading "BUDGET EXHAUSTED" banner.

- **SDK-enforced JSON schemas.** All planner calls (tasks, themes, steering) use `outputFormat` with JSON schemas so the SDK validates and retries internally before manual fallbacks fire.
- **Steering retry actually works.** Up to 3 retries, broken response sent back to the model for self-repair.
- **Honest failure banner.** Steering failures now show "STEERING FAILED" instead of "BUDGET EXHAUSTED."
- **File size guardrail.** Agents are instructed to keep files under ~500 lines.

## 1.8.1

### Completion screen

The end-of-run output was a cramped box that buried useful info. Replaced with a full-width completion screen.

- **Banner.** Green `COMPLETE` or yellow `BUDGET EXHAUSTED` header scaled to terminal width.
- **Stats grid.** Two-column layout: waves, sessions, cost, elapsed, merged branches, conflicts, tokens, tool calls  -- all scannable at a glance.
- **Status summary.** If the planner wrote a `status.md`, its content is displayed inline so you see the product-level assessment without opening files.

## 1.8.0

### Verification agents that actually verify

Verification agents were running in isolated git worktrees that lacked env files, installed dependencies, and local config  -- making it impossible to start a dev server or do real browser testing. They silently fell back to static code analysis and declared "verified."

- **`noWorktree` task field.** Tasks can now opt out of worktree isolation. The planner sets `"noWorktree": true` on verify and user-test tasks so they run in the main project directory with full access to the real environment.
- **Zero side-effect by design.** Agents without a worktree branch are automatically excluded from auto-commit and merge  -- no additional guards needed.
- **Relentless verification.** Agents are instructed to exhaust every option before giving up  -- search for dev login routes, test tokens, seed users, env vars; pick alternate ports; install missing deps; fix or work around build failures.

## 1.7.0

### Unified display & accurate cost tracking

The TUI no longer disappears between waves. A single `RunDisplay` class owns the render loop and hotkeys for the entire run  -- wave → steering → next wave transitions are seamless, with the header always visible.

- **Unified `RunDisplay`.** One render loop, one hotkey handler. Switches between wave mode (agent table + events) and steering mode (assessment text) without clearing the screen. No more jarring blank-then-rebuild between phases.
- **Accurate total cost.** Planner/steering API calls between waves were silently untracked. Added a cumulative cost counter in `planner.ts`; each steering call's cost delta is now captured and added to `accCost`. The displayed total reflects the real spend.
- **Session details in header.** Stats line now shows cumulative tokens, total cost, wave number, sessions used/budget, and remaining count (e.g. `$212.24  wave 3 · 15/100 sessions · 85 left`).
- **Shared header rendering.** Extracted `renderHeader()` used by both wave and steering frames  -- consistent layout from the first thinking phase through the last wave.

## 1.6.1

### Fix: resume with zeroed remaining budget

Resuming a run that had `remaining: 0` (despite unspent budget) would immediately exit with no work done. The saved `remaining` counter could drift to 0 through steerer "done" signals or unexplained consumption even when `accCompleted` was far below `budget`.

- **Resume recalculates remaining** from `budget - accCompleted` instead of restoring the saved value. Ensures the user gets back sessions that weren't successfully used.
- **Display matches recalculation.** The unfinished-run box now shows the true resumable budget, not the stale saved value.
- **Runtime drift guard.** After each wave, if `remaining` drops below `budget - accCompleted - accFailed`, it's corrected. Prevents ghost budget consumption regardless of cause.

## 1.6.0

### Free-form wave composition

The planner is no longer limited to execute/reflect/done. It can now compose any wave type  -- **critique**, **verify**, **user-test**, **explore**, **synthesize**, **polish**  -- or mix them freely. A wave can have 3 execute agents + 1 verification agent, or 2 divergent explorers, whatever the situation calls for. The old `buildReflectionTasks` is gone; reflection is just another wave the planner can compose.

- **Model per task.** Steering can assign `"worker"` or `"planner"` model to individual tasks  -- review/verification tasks get the planner model, implementation gets the worker.
- **Design thinking.** All planning prompts now carry a core framing: start from the user's job, the experience IS the product, build-verify-iterate, consistency over features.
- **Verification gate.** The planner cannot declare "done" until at least one verification wave has actually run the app. No more "looks good from reading the code."

### Multi-run resume

- **Multiple incomplete runs.** If several runs are unfinished, a numbered list lets you pick which to resume (single keystroke, up to 9).
- **Run history.** Press `h` at the resume prompt to see full history  -- time ago, cost, phase, merged branches, last status line.
- **CWD-scoped.** Runs are filtered to the current working directory, so different projects don't interfere.
- **Wave history on resume.** Session files are reloaded so the planner has full context of prior waves, not just the last state snapshot.
- **Resume steering.** Flex runs that resume with no queued tasks immediately steer to get the next wave instead of stopping.

### Resilience

- **Steering failure preserves budget.** A failed steer no longer zeroes out remaining budget  -- the run stays resumable with unspent sessions intact.
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

- **Live overall cost.** Stats line now shows both wave cost and running total: `$0.092 / $0.45 total`. Previously showed only the current wave's cost  -- the accumulated cost from previous waves was only visible in the static wave header.
- **Extra usage budget bar.** When using extra usage with a dollar budget, a dedicated progress bar shows spend vs limit: `Extra ████████░░░░░░  $0.82/$2.00`. Colors shift magenta → yellow → red as the budget fills. Replaces the old inline `[EXTRA USAGE $X/$Y]` text on the usage bar.

## 1.4.0

### Auto-simplify pass

Every agent now runs a self-review pass after completing its task. The agent's session is resumed with a simplify prompt that tells it to `git diff`, check for code reuse opportunities, quality issues, and inefficiencies, then fix them directly.

- Uses the existing interrupt+resume infrastructure  -- no extra agent sessions consumed
- Non-fatal: if the simplify pass fails (timeout, rate limit), the task is still marked done
- Review checklist covers: existing utility reuse, redundant state/copy-paste/unnecessary abstractions, and efficiency (redundant work, missed concurrency, unbounded structures)

## 1.3.0

### Interrupt + resume for silent queries

Agents and planner queries that go silent are no longer killed immediately. Instead, they are interrupted and resumed with full conversation context via the SDK's `interrupt()` + session resume mechanism.

- **Agents**: silent for 15min → interrupt + resume with "Continue". Silent for another 30min → hard kill. Configurable via `--timeout`.
- **Planner**: silent for 15min → interrupt + resume. Silent for another 30min → hard kill.
- Uses SDK `persistSession: true` and `resume: sessionId`  -- the resumed query picks up with all prior tool calls, file reads, and partial work intact.

### Extra usage improvements

- **Smooth extra usage transition.** When extra usage is allowed, hitting plan limits no longer flashes "rejected" status or blocks dispatch  -- agents continue seamlessly into overage. Log shows "switching to extra usage" instead.
- **Extra usage budget shown in UI.** The `[EXTRA USAGE]` tag now displays spend vs budget, e.g. `[EXTRA USAGE $1.23/$5]`.
- **Fixed stale "Waiting for reset 0s" display.** Rate limit reset deadline is cleared when agents resume, and expired deadlines are no longer rendered.

### Internal

- Unified `NudgeError` class in types.ts (was duplicated as `PlannerNudgeError` + `AgentNudgeError`).
- Removed dead `rateLimitStatus` field.
- Default agent inactivity timeout raised from 5min to 15min.

## 1.2.1

- Full progress UI during all planner phases  -- theme identification, orchestration, steering, and reflection now show elapsed time, cost, utilization %, and streaming text instead of bare spinners.

## 1.2.0

### Extra usage protection

- **Extra usage is blocked by default.** When your plan's rate limits are exhausted, the run stops cleanly and is resumable  -- no surprise bills.
- Interactive step ⑤ lets you opt in: No / Yes with $ limit / Yes unlimited.
- CLI: `--allow-extra-usage`, `--extra-usage-budget=N`.
- Overage detection via SDK `isUsingOverage` flag  -- immediately stops dispatch when detected and not allowed.

### Live controls during execution

- Press `b` to change remaining budget, `t` to change usage cap, `q` to stop (twice to force quit).
- Changes apply between waves  -- active agents finish their current task.

### Multi-window usage display

- Usage bar cycles through all rate limit windows (5h, 7d, 7d opus, 7d sonnet, overage) every 3 seconds.
- Usage info (cost, utilization %) now shown during all phases  -- thinking, orchestration, steering, and execution.

### Per-wave cost tracking

- Wave headers now show cumulative spend: `◆ Wave 2 · 12 tasks · 38 remaining · $14.20 spent`.

### Internal

- Consolidated overage enforcement into `capForOverage()`  -- consistent behavior between throttle and rate limit event handler.
- Planner rate limit state resets per query (no more stale cumulative cost across waves).
- Early exit in `throttle()` prevents duplicate log messages from multiple workers.
- Live config uses dirty flag instead of fragile value comparison.

## 1.1.0

- Updated README with resilience documentation.

## 1.0.3

- Any premature stop is resumable (not just capped  -- also crashed, aborted, steering failures).
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
