# Authoring a claude-overnight Run

Read this before finalizing a `tasks.json` or telling the user to press Run. Pair with `recipes.md` for the scenario matrix.

## Decision tree

1. **Does the user have a concrete list of tasks with a clear endpoint?**
   - Yes → **fixed plan**: `tasks.json` with explicit `tasks[]`, `--no-flex`, skip thinking wave (auto-skipped below budget 15; for higher budgets pass a pre-written `tasks.json`, the CLI will not re-plan).
   - No → continue.

2. **Is the objective fuzzy ("modernize", "audit", "clean up", "make it amazing")?**
   - Yes → **flex plan**: `objective` + `flexiblePlan: true` + 2–5 seed tasks. Let the thinking wave explore and steering drive. Budget ≥ 30.
   - No but also not concrete → write 3–5 seed tasks you *know* are needed, enable flex, and let steering add the rest.

3. **Is this a single-wave mechanical job (docs, formatting, coverage fill)?**
   - Yes → `--no-flex`, skip thinking, low-cost worker (Qwen or Sonnet), high concurrency OK.

4. **Is this a shared-surface problem (migration, bug hunt, one-file refactor)?**
   - Yes → low concurrency (2–4). Merge conflicts dominate otherwise.

5. **Does completion require running the app (not just reading code)?**
   - Yes → task prompts must *explicitly* instruct run-and-test. Add `afterWave` hook to run tests. See *verify-before-done* below.

## Pre-flight critic checklist

Walk the proposed run against each item before Run. One fail = revise.

### Task shape
- [ ] **No "do anything" prompts.** Every task names a scope (files, module, feature) and a concrete outcome. If a task reads "improve X", decompose it first.
- [ ] **Language-agnostic phrasing.** Don't bake in `npm`, `jest`, `pnpm`, etc., in the objective unless the repo is pinned to them. Shape meta-prompts ("run the project's test suite"), not tool names.
- [ ] **Verify-before-done.** Each task that changes behavior must include "run and test the change", not just "edit the code". For UI tasks, require browser verification (Playwright MCP). For backend, require the test suite or a repro script.
- [ ] **Decomposition is real.** If a task is >1 day of human work, split. If two tasks touch the same file heavily, merge or serialize (low concurrency).
- [ ] **One outcome per task.** No "refactor auth AND add tests AND update docs", that's three tasks.

### Budget & economics
- [ ] **Budget ≥ per-wave cost × expected waves.** For flex runs, expect 3–6 waves. Per-wave cost = planner (~$1–3) + tasks × worker cost.
- [ ] **Thinking wave justified.** Skip if tasks are already concrete or budget < 15. Thinking at budget=2000 costs $15–40, worth it only for genuine exploration.
- [ ] **Planner isn't cheaped out.** Planner quality = run quality ceiling. Opus for high-stakes, Sonnet for everyday, never Qwen for planner.
- [ ] **Usage cap set.** Default 90% leaves headroom for interactive Claude. `--allow-extra-usage` off unless the user explicitly opts in, and only with `--extra-usage-budget=N`.

### Environment & safety
- [ ] **Clean git tree** (or user has explicitly OK'd uncommitted changes being swept into worktrees).
- [ ] **`.claude-overnight/` in `.gitignore`** (with trailing slash, the `.md` log file at repo root stays committable).
- [ ] **Required env / keys present.** API keys, DB URLs, auth tokens: if the worker needs them, the repo's `.env` must have them (worktrees inherit).
- [ ] **MCP servers configured** for parallel Playwright (one `--isolated` entry per concurrency slot, or shared `--isolated --headless` if no login needed).
- [ ] **Hooks don't abort the run.** `beforeWave`/`afterWave`/`afterRun` failures surface but never stop, make sure that's what the user wants.

### Circuit-breaker awareness
- [ ] **User knows to watch for 2 consecutive zero-file-change waves**: that's the halt signal. Silent try/catch in wave loops is a landmine; if the run looks "busy but unchanged", stop it.
- [ ] **First-attempt failure mitigation.** First planner call is expensive ($2–4). If the objective can be expressed as concrete tasks, skip the planner entirely.

## Common anti-patterns

### The "overnight hail-mary"
User dumps a vague wish + $1000 budget + flex + max concurrency and walks away. Output: 200 worktrees, 50 merge conflicts, no coherent diff, $400 of steering context-shuffling.
**Fix:** decompose the wish into 5–10 seed tasks, start at budget=50, verify the first wave delivers before topping up (live `b` key).

### The "single agent, do everything"
One task prompt: "refactor the whole auth system". One agent touches 40 files, simplify pass can't review a sprawl, merge succeeds but the result is incoherent.
**Fix:** decompose into per-surface tasks (middleware, session store, tokens, tests). Let steering add integration work.

### The "verification theater"
Tasks say "add tests" but don't say "run them". Agent writes plausible-looking tests that don't compile. Final gate catches it, but 10 waves in.
**Fix:** every behavior-changing task ends with "run the test suite and ensure it passes". `afterWave: "pnpm test"` adds a safety net.

### The "wrong tool for the job"
Using flex mode for a mechanical docs sprint, planner burns budget steering a problem that needs no steering.
**Fix:** `--no-flex` for mechanical work.

### The "proxied model mystery"
Worker is on Cursor proxy. User wonders why there are no thinking deltas in transcripts.
**Fix:** expected behavior, Cursor proxy suppresses thinking phase (see README table). Don't chase it.

## Writing a good objective (for flex runs)

Structure: `<verb> <scope> so that <outcome / quality bar>`.

Good:
- "Modernize the auth system so that session tokens meet SOC2 storage requirements and existing flows continue to work."
- "Raise test coverage in `packages/api` to >80% line coverage, prioritizing error paths and boundary cases."

Bad:
- "Make the code better." → no scope, no outcome.
- "Do whatever needs doing on auth." → no quality bar.
- "Refactor everything and add features." → two objectives.

The `goal.md` file lets steering evolve the "north star", but it can only evolve a seed that's already grounded. A vague seed stays vague.

## Writing good seed tasks (flex mode)

Each seed should:
1. Name a scope (file, module, feature, package).
2. Name an outcome (what "done" looks like).
3. Be independently verifiable (a test, a build step, a visible UI change).
4. Not overlap heavily with siblings (otherwise serialize or drop concurrency).

Example seeds for "Modernize auth":
- "Audit `packages/auth/middleware.ts` and document the session-token storage approach, flagging SOC2 gaps."
- "Add a reproduction test for the current session-token storage that fails under the new SOC2 requirement."
- "Design a migration path from cookie storage to encrypted-at-rest store; output as `designs/auth-migration.md`."

Steering will add execution tasks (the actual migration code) in later waves, grounded in what the seeds found.

## When to invoke the coach skill vs. this one

- **`claude-overnight` skill** (this one): Claude helps the user plan an overnight run *outside* the CLI, picking shape, writing tasks.json, critiquing budget.
- **`claude-overnight-coach` skill**: runs *inside* the CLI at startup, turns a raw objective into recommended settings + checklist. Different entry point, overlapping knowledge. Don't invoke coach from here.
