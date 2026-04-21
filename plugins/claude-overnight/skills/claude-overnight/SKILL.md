---
name: claude-overnight
description: >
  Understand, author, install, and inspect claude-overnight runs: a CLI that
  launches parallel coding agents in git worktrees with a self-curating skill
  memory that improves mid-run, multi-wave steering, three-layer review, and
  crash-safe resume. Mix Opus planner with Kimi 2.6, Cursor composer-2, Gemini,
  Qwen, or any Anthropic-compatible worker. Use when the user mentions
  claude-overnight, a `.claude-overnight/` folder, an "overnight" or "swarm"
  run, asks to check status / resume / continue a multi-phase plan, or asks to
  plan / design / write a `tasks.json` / objective / overnight workflow.
  Not for Vercel Workflow DevKit.
---

# What it is

`claude-overnight` is a CLI (npm: `claude-overnight`, bin: `claude-overnight`) that takes an objective + budget and launches many agent sessions in parallel, each in an isolated git worktree. It is a local multi-session orchestrator built on top of the Claude Agent SDK (not itself an agent harness, but a layer that plans, dispatches, and steers many sessions running on the SDK's harness). Three roles are picked independently: **planner** (thinks, steers, reviews; typically Opus or Sonnet), **main worker** (runs the tasks; Sonnet / Gemini / Qwen / DeepSeek / any Anthropic-compatible endpoint), and an optional **fast worker** (a cheaper/faster second worker for well-scoped tasks, verified by the next wave's workers; typically Kimi 2.6 Coding, Cursor composer-2, or Haiku). A "thinking wave" of architect sessions explores the codebase, an orchestrator synthesizes concrete tasks, worker waves run them in parallel, and steering decides between more work, reflection, or declaring done. Rate limits, crashes, and usage caps are all resumable; nothing is lost.

**Self-curating skill memory.** Workers emit memory candidates during execution when they find a reusable pattern. At the end of every wave a **librarian** pass curates the queue: promotes into canon, patches existing skills via diff-style edits, or quarantines stale ones. Wave N+1 of the same run starts with a better skill library than wave N. Inspired by Nous Research's Hermes Agent, with progressive disclosure (L0 stub, L1 body on demand, L2 references), SQLite FTS5 retrieval, and per-skill win-rate tracking.

**Three-layer review system** runs on every wave:
1. **Per-agent self-review**: after each agent finishes, the same session continues via SDK session resume (continue mechanism) with a follow-up prompt to review and simplify its own `git diff`. The agent's full context stays warm; no initial context bloat.
2. **Post-wave review**: after each wave (flex mode), a dedicated review agent inspects the consolidated diff for issues individual agents blind-spotted.
3. **Post-run final gate**: before shipping, a comprehensive review runs against the full `git diff main`.

Repo: https://github.com/Fornace/claude-overnight

# Install / run

```bash
npm install -g claude-overnight      # Node >= 20; needs Claude auth or ANTHROPIC_API_KEY (or Qwen 3.6 Plus, see repo README)
claude-overnight                      # interactive in cwd
claude-overnight tasks.json           # task file mode
claude-overnight "task a" "task b"    # inline
```

Common flags: `--budget=N`, `--concurrency=N`, `--model=<name>`, `--usage-cap=N`, `--allow-extra-usage`, `--extra-usage-budget=N`, `--timeout=SECONDS`, `--no-flex`, `--dry-run`.

Task file supports lifecycle hooks, shell commands run in `cwd` at key points:

```json
{
  "objective": "...",
  "beforeWave": "pnpm run db:generate",
  "afterWave":  "supabase db push",
  "afterRun":   "vercel deploy --prod",
  "tasks": []
}
```

`beforeWave` runs before each wave starts · `afterWave` runs after workers merge (before review/steering) · `afterRun` runs once after the entire run. All accept a string or `string[]`. Failures are surfaced but never abort the run.

Live keys while running: `b` change budget · `t` change usage cap · `q` graceful stop (twice = force).

Exit codes: `0` all ok · `1` some failed · `2` all/none.

# Authoring a run (tasks.json / objective)

When the user asks you to *plan*, *design*, or *write* an overnight run (not inspect one), load the authoring knowledge **on demand**, don't carry it by default:

- `recipes.md` (next to this file): scenario → recipe matrix covering objective shape, `flexiblePlan`, initial tasks, `concurrency`, budget range, planner/worker pairing, phases to skip. Read this when picking a run shape for a known scenario (refactor, feature batch, migration, test/docs sprint, bug hunt, research).
- `authoring.md` (next to this file): decision tree (fixed vs flex vs inline; when to `--no-flex`; when thinking wave is wasted), pre-flight critic checklist (no "do anything" prompts, language-agnostic phrasing, verify-before-done, budget ≥ per-wave cost × expected waves, decomposition sanity), and anti-patterns. Read this before finalizing any tasks.json or before pressing Run.

Rule of thumb: if the user has a concrete list of tasks and a clear endpoint, prefer fixed-plan (`--no-flex`) and skip the thinking wave. If the user has a fuzzy objective ("modernize X", "audit Y"), prefer `objective + flexiblePlan: true` with a small seed task list and let steering drive. Never send a single "do anything" prompt to one agent, decompose first (see authoring.md).

# On-disk layout (this is how you inspect status)

Every run lives at `<repo>/.claude-overnight/runs/<ISO-timestamp>/`:

| File / dir           | What it tells you                                                                 |
|----------------------|-----------------------------------------------------------------------------------|
| `run.json`           | Machine state: objective, planner/main-worker/fast-worker models, budget, cost, waves done, branches, done flag. |
| `status.md`          | **Living project snapshot**, rewritten by steering every wave. First line = short status. |
| `goal.md`            | Evolving "north star": what the run currently thinks "amazing" means.            |
| `themes.md`          | The thinking-wave research angles picked for this objective (human-readable).     |
| `milestones/*.md`    | Strategic snapshots archived ~every 5 waves. Long-term memory of the run.         |
| `designs/*.md`       | Architect outputs from the thinking wave. Deleted once the objective is complete. |
| `tasks.json`         | The execution plan written by the orchestrator.                                   |
| `steering/wave-N-attempt-M.json` | Steering decision per wave: done flag, reasoning, status/goal updates.   |
| `transcripts/*.ndjson` | Crash-safe NDJSON stream for every planner/steering query: `themes`, `orchestrate`, `plan`, `steer-wave-N-attempt-M`. Each line = one event (session_start, tool_use, text_delta, thinking_delta, rate_limit, result, error). Use `jq -c '.kind' <file>` to get a quick shape; read full objects to reconstruct what the planner was doing. Survives process crashes because writes are append-only. |
| `sessions/wave-N.json` | Per-wave agent records: prompt, status, cost, files changed, branch, error.    |

The newest subfolder under `runs/` is the current/last run. A run that never reached "done" is **resumable**, `run.json` will not be marked complete and `designs/` may still be present.

To assess status of a run from scratch, read in this order: `goal.md` → `status.md` → newest file in `milestones/` → newest `sessions/wave-*.json` → `run.json`. Five reads and you know exactly where it stands. If the run died during planning (no `sessions/` yet), read `themes.md` + the newest `transcripts/*.ndjson` instead, they show exactly what the planner was doing when it crashed.

**Durable run history (committed, survives cleanup):** `claude-overnight.log.md` at the repo root is updated on every run with a block per run ID, original objective, start/finish times, cost, outcome, branch. If the user asks "what was my prompt" or "what did last night's run do" and `.claude-overnight/runs/` is empty, this file is the canonical recovery path.

# Resume / continue

Just run `claude-overnight` again in the same repo. It auto-detects the unfinished run and shows a **Resume / Fresh / Quit** prompt. On resume: unmerged `swarm/task-*` branches auto-merge, the wave loop continues, status/goal/milestones/designs are preserved. If orchestration crashed after the thinking wave, surviving `designs/*.md` are reused, no re-paying for architects.

For **multi-phase plans** (task file with `objective` + `flexiblePlan: true`), resuming picks up at the next wave with full steering context. Don't hand-edit `run.json` to "fix" a stuck run unless something is demonstrably corrupt, prefer re-running and letting steering re-assess.

Merged branches from prior runs are not re-run. Knowledge carries forward across runs: new runs see what completed runs built.

# Diagnosing a stuck / failed run

1. Read `status.md` (living snapshot) and the newest `sessions/wave-*.json`.
2. Check for `swarm/task-*` branches left behind (`git branch --list 'swarm/*'`), these are unmerged worktree outputs, usually from a conflict or crash.
3. Look at `run.json` for `done`, `lastError`, usage/cost fields.
4. If the thinking wave succeeded but orchestration crashed, `designs/` will still contain the architect docs, a resume will reuse them.
5. If rate-limited, the tool waits and retries on its own, do not kill it unless the user asks.

# What NOT to do

- Don't micromanage the tool. It has its own planner, steering, and goal refinement, trust them.
- Don't invent a resume procedure. The CLI handles resume itself; the correct action is almost always "re-run `claude-overnight` in the repo".
- Don't delete `.claude-overnight/` to "clean up", it holds the only record of what the run learned. It should be in `.gitignore`.
- Don't truncate or summarize agent output files when reading them back, never discard expensive agent output.
- Don't confuse this with Vercel Workflow DevKit, unrelated despite the word "workflow".

# Playwright Parallel Usage

When agents use the Playwright MCP server for testing, parallel instances conflict on browser locks and cookie state. See `QUICKSHEET_PLAYWRIGHT.md` at the repo root for the full reference.

**Quick rules:**
- **Headless by default**, prevents focus stealing on macOS. Only use headed when anti-bot detection (CAPTCHA, Cloudflare) forces it
- **Isolated agents (no login):** Each MCP server needs `--isolated --headless`
- **Isolated agents (with saved login):** Each needs its own `userDataDir` or `--storage-state` file, plus `--headless`
- Multiple MCP entries in `settings.json`, one per concurrency slot, or use a single `--isolated` entry if cookies don't need to persist

**Context7 (ctx7) docs:** Requires authentication (`npx ctx7@latest login` or `CONTEXT7_API_KEY`). Pre-flight check:

```bash
npx ctx7@latest library playwright "parallel browser instances"
```

If this fails with a quota/auth error, fall back to training data, don't block the run.
