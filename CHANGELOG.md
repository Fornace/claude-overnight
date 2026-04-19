# Changelog

## 1.25.49

### Authoring guidance for the `claude-overnight` Claude Code skill

The plugin skill previously only taught Claude how to *inspect* and *resume* runs. It didn't teach Claude how to *author* a run — picking shape, writing `tasks.json`, critiquing budget and decomposition. That knowledge was tribal.

- **`SKILL.md`** — frontmatter now triggers on authoring intents ("plan", "design", "write tasks.json", "overnight workflow") in addition to inspect/resume. Added a compact "Authoring a run" section with a rule-of-thumb and pointers to two sibling files loaded on demand.
- **`recipes.md`** (new, on-demand) — scenario → recipe matrix covering fixed refactor, feature batch, framework migration, test sprint, docs sprint, bug hunt, codebase audit, framework-wide cleanup, long research run. Each row: objective shape, `flexiblePlan`, budget range, concurrency, planner/worker pairing, phases to skip. Plus budget heuristics, model pairing defaults, phase-skip cheatsheet, and anti-recipes.
- **`authoring.md`** (new, on-demand) — 5-step decision tree (fixed vs flex vs mechanical), pre-flight critic checklist (task shape · budget · environment · circuit-breaker), common anti-patterns with fixes, objective+seed task templates, coach-vs-skill delimitation.

Pattern matches the Vercel plugin approach: thin topic-sized chunks loaded only when the matching intent fires, so the default context stays small.

## 1.25.42

### Fast-worker reframe — steering now routes well-scoped tasks to the fast model

In a real `1.25.41` run on a closure-heavy plan, steering assigned **0 of 51 tasks** to the fast model despite at least 10–15 being textbook fast candidates (single-line prompt edits, stdlib-only scripts, shell wrappers, running existing tests and capturing output, docs updates). The culprit was framing: the prompt called it "fast" vs "worker," which read as a second tier to fall back to rather than a peer worker.

Across prompts, skills, README, and CLI text, the fast model is now consistently framed as a **fast worker** — a real worker, same tools, same env, on a cheaper/faster model — sitting beside the **main worker**. Both are first-class.

- **Steering prompt** (`src/steering.ts`) — rewrote the model-selection section. Opens with "you have **two kinds of workers**, both first-class." Fast-worker criteria expanded to include surgical multi-line changes with a clear spec, stdlib-only utilities, docs/markdown updates, and running existing scripts/tests. Explicit guidance added: *"when in doubt, pick 'fast'"* and *"over-using 'worker' is a real cost."*
- **Coach skill** (`plugins/.../coach/SKILL.md`) — roles renamed to planner / main worker / fast worker. Settings matrix commentary clarifies the fast worker is a real worker on a cheaper model, routed to by default for well-scoped tasks.
- **Claude-overnight skill** (`plugins/.../claude-overnight/SKILL.md`) — "three roles" paragraph and `run.json` row updated to use the new terminology.
- **README** — planner / main-worker / fast-worker language throughout; routing paragraph updated.
- **CLI + picker** — `--fast-model` help, fast-provider degrade message, and interactive picker labels all say "fast worker."

### Simplify delegated to the bundled skill

Per-agent self-review (`SIMPLIFY_PROMPT` in `src/swarm.ts`) and post-wave/post-run review (`reviewPrompt` in `src/run.ts`) no longer inline a long checklist. They now invoke the bundled `simplify` skill, which cursor-composer-in-claude 0.10.0 materialises as a `.cursor/rules/*.mdc` file in the worktree so proxied workers honour it the same way a direct Anthropic worker does. Net: much smaller review prompts, one source of truth for the simplify rubric, and parity between the main and fast worker on review passes.

## 1.25.41

### Proxied fast-model parity (PROXIED_FAST_MODEL_RESEARCH.md — Path D)

Fast models routed through the Cursor proxy (composer-2-fast and friends) now honour Anthropic skills and sub-agents the same way a direct Anthropic worker does. Three fixes, all driven by `docs/PROXIED_FAST_MODEL_RESEARCH.md`:

- **Per-agent `X-Cursor-Workspace` header.** cursor-agent ignores the Agent SDK's `cwd` option and uses its own workspace resolution, so two proxied agents in separate worktrees both executed against the proxy's startup cwd — a real isolation bug. `swarm.ts` now injects `ANTHROPIC_CUSTOM_HEADERS: X-Cursor-Workspace: <agentCwd>` whenever the env routes through the proxy; each worktree agent now writes to its own tree.
- **Proxy spawn sets `CURSOR_BRIDGE_WORKSPACE=/`.** Needed so the per-request workspace header validates against the proxy's configured base (was defaulting to the caller's cwd, which rejected worktree paths).
- **Bundled skill translation + sub-agent tool parity.** Requires `cursor-composer-in-claude@^0.10.0`, which (a) materialises the four Anthropic bundled skills — `/init`, `/review`, `/simplify`, `/security-review` — as `.cursor/rules/<name>.mdc` in the workspace, so cursor-agent auto-discovers and follows them verbatim; and (b) translates cursor-agent's native `tool_call` events (including `taskToolCall` for parallel sub-agents) into Anthropic `tool_use` blocks, so claude-overnight's progress UI, budget tracking, and nudge-on-silence now see proxied-model tool activity turn by turn.

Steering prompt and coach skill updated to recommend fast models more broadly (not only Haiku), now that proxied fast models behave like a first-class endpoint.

## 1.25.5

### Wave lifecycle hooks

Three new task file fields let you run shell commands at key points in the wave loop — completely technology-agnostic, just shell commands in `cwd`:

```json
{
  "beforeWave": "pnpm run db:generate",
  "afterWave":  "supabase db push",
  "afterRun":   "vercel deploy --prod"
}
```

- **`beforeWave`** — runs before each wave starts. Useful for generating types from the current schema so workers have accurate types.
- **`afterWave`** — runs after each wave's workers finish and merge, before the post-wave review and steering. The canonical place for migration commands: schema is applied before the review agent runs build/tests.
- **`afterRun`** — runs once after the entire run finishes (any outcome: done, capped, stopped), after the git checkout back to the original branch. For deploy, notify, or cleanup commands.

All three accept a string or array of strings. Failures are surfaced in the display but never abort the run. Order per wave: `beforeWave` → workers → merge → `afterWave` → post-wave review → steering.

### Planner tool expansion

The planning phase was restricted to `["Read", "Glob", "Grep", "Write"]`. Now expanded to include `Bash`, `WebFetch`, `WebSearch`, `TodoWrite`, and `Agent` — letting planners run `git log`, fetch library docs, track analysis progress with a todo list, and spawn sub-agents for deeper codebase exploration.

Workers were never restricted (no `tools` param = all built-in tools available by default).

### Wave debrief footer

After each wave finishes, a fast model writes a one-line progress summary into the display footer. Visible in both swarm and steering views so the current wave's intent is always on screen.

### UI polish

- **COMPLETE tag** in the header + `"(all tasks done — processing)"` event indicator so the UI is never ambiguous when a wave finishes before steering kicks in.
- **Elastic content area** — `renderUnifiedFrame` now shrinks the content area to fit the maxRows budget, so the header, footer, and input prompt are never clipped on small terminals.
- **Alt/Option+key sequences** no longer cancel steer/ask input on macOS.

## 1.25.0

### Model catalog expansion + capability-based task scoping

The model catalog now covers **Anthropic, OpenAI (GPT-5.4, Codex 5.3), Google Gemini 3, DeepSeek V3.2, Meta Llama 4, and Qwen 3**  -- with `safeContext` (conservative usable tokens) alongside `contextWindow` (declared). Planners use `safeContext` to scope tasks to what models can actually handle, not their advertised context. Deprecated models removed (Claude 4.5, Opus 4, composer-2-fast).

### Cursor proxy hardening

- **User API key required.** Cursor providers now hard-fail at startup without a key (`CURSOR_API_KEY`, `CURSOR_BRIDGE_API_KEY`, or saved in providers.json). Prevents silent Keychain fallback.
- **Sequential cursor preflights.** The bundled proxy handles one agent query at a time, so cursor preflights now run sequentially (60s timeout) instead of parallel (which starved each other).
- **macOS zsh patch detection.** Warns once if Cursor's `agent` CLI is installed but the shell workaround from README is missing.
- **CI + keychain skip forced early.** `bin.ts` now sets `CI=true` and `CURSOR_SKIP_KEYCHAIN=1` at process start (not `??=`), so parent shell values like `CI=0` can't leak in.
- **Proxy auto-restart with token.** `ensureCursorProxyRunning` replaces stale listeners by default when a token exists, ensuring the proxy always inherits `CURSOR_API_KEY`. Opt out: `CURSOR_OVERNIGHT_NO_PROXY_RESTART=1`.
- **Dependency:** `cursor-composer-in-claude` **0.8.0**.

### Other

- **Objective prompt simplified.** Removed the 5-word minimum constraint.
- **New docs:** `docs/CURSOR_PROXY_MACOS_DISCOVERY.md`  -- full investigation of headless Cursor + macOS Keychain.
- **New test:** `cursor-env.test.ts`  -- verifies Cursor env injection for keychain avoidance.
- **Matrix test script:** `npm run matrix:cursor-proxy`  -- regression / stress test for Cursor proxy configurations.

## 1.24.4–1.24.8

Cursor proxy reliability fixes: listener-only kill (no more SIGKILLing the parent process), stale proxy version detection and auto-restart, bridge key mirroring into `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`, forced `CI=true` on agent spawn. `cursor-composer-in-claude` 0.7.6 → 0.7.9.

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

## 1.11.3–1.11.12

Rate-limit reliability: SDK `rate_limit_event` rejections now retry instead of silently burning budget; throttle loops until clear with escalating backoff; rate-limit errors don't consume retries. Bracketed paste mode for multi-line input. Agent self-commits no longer orphan branches (filesChanged measured from baseRef, not worktree status). macOS `/private` tmpdir workaround for stale-worktree cleanup. Plan-phase salvage + resume (orphaned `tasks.json` recovered at startup). Durable `claude-overnight.log.md` run history (committed, survives `.claude-overnight/` cleanup). Never-started tasks survive abort/cap.

## 1.11.0

Restored interactive options lost in 0.2.0: worktree/merge/permission prompts, user-controlled concurrency, all as CLI flags too. `[f] fix` hotkey re-queues errored tasks. Worktree creation retries on stale branches.

## 1.10.0

`[s] steer` and `[?] ask` hotkeys  -- queue directives or ask the planner mid-run without interrupting agents. File-based steer inbox works without a TTY.

## 1.9.1

ESM require crash fix, resume budget accounting (failed sessions, thinking overhead), `identifyThemes` cwd, `formatTimeAgo` NaN guard.

## 1.8.0–1.8.4

Verification agents run in real project dir (`noWorktree`). Structured output schemas for all planner calls. Auto-verification on done-blocked. Steering reasoning saved to disk. Accurate exit messages. Completion screen with stats grid. 45-min wall-clock limit on planner calls.

## 1.7.0

Unified `RunDisplay`  -- no more screen clearing between waves. Accurate total cost tracking (planner/steering calls included). Session details in header.

## 1.6.0–1.6.1

Free-form wave composition (any wave type, model per task, verification gate). Multi-run resume picker with history. Resume recalculates remaining from actuals. `.claude-overnight/latest` symlink.

## 1.5.1

Live overall cost in stats line. Extra usage budget progress bar.

## 1.4.0

Auto-simplify pass: every agent self-reviews via SDK session resume after completing its task.

## 1.3.0

Interrupt + resume for silent queries (15min → interrupt, 30min → kill). Smooth extra usage transition.

## 1.2.0–1.2.1

Extra usage protection (blocked by default, opt-in with `--allow-extra-usage`). Live `[b]`/`[t]`/`[q]` hotkeys. Multi-window usage display. Full progress UI during all planner phases.

## 1.0.0–1.1.0

Initial release. Interactive mode, flex mode, three-layer context, per-run folders, cross-run knowledge inheritance, crash recovery, resume, git worktree isolation, rate limit handling.
