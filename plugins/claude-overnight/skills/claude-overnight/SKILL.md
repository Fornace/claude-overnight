---
name: claude-overnight
description: >
  Understand, install, and inspect claude-overnight runs  -- a CLI that
  launches parallel Claude agents in git worktrees with thinking waves,
  multi-wave steering, three-layer review, and crash-safe resume. Use when the user mentions
  claude-overnight, a `.claude-overnight/` folder, an "overnight" or
  "swarm" run, or asks to check status / resume / continue a
  multi-phase plan. Not for Vercel Workflow DevKit.
---

# What it is

`claude-overnight` is a CLI (npm: `claude-overnight`, bin: `claude-overnight`) that takes an objective + budget and launches many Claude agent sessions in parallel, each in an isolated git worktree. It's a local multi-session orchestrator built on top of the Claude Agent SDK  -- not itself an agent harness, but a layer that plans, dispatches, and steers many sessions that run on the SDK's harness. A "thinking wave" of architect sessions explores the codebase, an orchestrator synthesizes concrete tasks, executor waves run them in parallel, and steering decides between more execution, reflection, or declaring done. Rate limits, crashes, and usage caps are all resumable  -- nothing is lost.

**Three-layer review system** runs on every wave:
1. **Per-agent self-review**  -- after each agent finishes, the same session continues via SDK session resume (continue mechanism) with a follow-up prompt to review and simplify its own `git diff`. The agent's full context stays warm  -- no initial context bloat.
2. **Post-wave review**  -- after each wave (flex mode), a dedicated review agent inspects the consolidated diff for issues individual agents blind-spotted.
3. **Post-run final gate**  -- before shipping, a comprehensive review runs against the full `git diff main`.

Repo: https://github.com/Fornace/claude-overnight

# Install / run

```bash
npm install -g claude-overnight      # Node >= 20; needs Claude auth or ANTHROPIC_API_KEY (or Qwen 3.6 Plus  -- see repo README)
claude-overnight                      # interactive in cwd
claude-overnight tasks.json           # task file mode
claude-overnight "task a" "task b"    # inline
```

Common flags: `--budget=N`, `--concurrency=N`, `--model=<name>`, `--usage-cap=N`, `--allow-extra-usage`, `--extra-usage-budget=N`, `--timeout=SECONDS`, `--no-flex`, `--dry-run`.

Live keys while running: `b` change budget · `t` change usage cap · `q` graceful stop (twice = force).

Exit codes: `0` all ok · `1` some failed · `2` all/none.

# On-disk layout (this is how you inspect status)

Every run lives at `<repo>/.claude-overnight/runs/<ISO-timestamp>/`:

| File / dir           | What it tells you                                                                 |
|----------------------|-----------------------------------------------------------------------------------|
| `run.json`           | Machine state: objective, model, budget, cost, waves done, branches, done flag.   |
| `status.md`          | **Living project snapshot**, rewritten by steering every wave. First line = short status. |
| `goal.md`            | Evolving "north star"  -- what the run currently thinks "amazing" means.            |
| `milestones/*.md`    | Strategic snapshots archived ~every 5 waves. Long-term memory of the run.         |
| `designs/*.md`       | Architect outputs from the thinking wave. Deleted once the objective is complete. |
| `sessions/wave-N.json` | Per-wave agent records: prompt, status, cost, files changed, branch, error.    |

The newest subfolder under `runs/` is the current/last run. A run that never reached "done" is **resumable**  -- `run.json` will not be marked complete and `designs/` may still be present.

To assess status of a run from scratch, read in this order: `goal.md` → `status.md` → newest file in `milestones/` → newest `sessions/wave-*.json` → `run.json`. Five reads and you know exactly where it stands.

**Durable run history (committed, survives cleanup):** `claude-overnight.log.md` at the repo root is updated on every run with a block per run ID  -- original objective, start/finish times, cost, outcome, branch. If the user asks "what was my prompt" or "what did last night's run do" and `.claude-overnight/runs/` is empty, this file is the canonical recovery path.

# Resume / continue

Just run `claude-overnight` again in the same repo. It auto-detects the unfinished run and shows a **Resume / Fresh / Quit** prompt. On resume: unmerged `swarm/task-*` branches auto-merge, the wave loop continues, status/goal/milestones/designs are preserved. If orchestration crashed after the thinking wave, surviving `designs/*.md` are reused  -- no re-paying for architects.

For **multi-phase plans** (task file with `objective` + `flexiblePlan: true`), resuming picks up at the next wave with full steering context. Don't hand-edit `run.json` to "fix" a stuck run unless something is demonstrably corrupt  -- prefer re-running and letting steering re-assess.

Merged branches from prior runs are not re-run. Knowledge carries forward across runs: new runs see what completed runs built.

# Diagnosing a stuck / failed run

1. Read `status.md` (living snapshot) and the newest `sessions/wave-*.json`.
2. Check for `swarm/task-*` branches left behind (`git branch --list 'swarm/*'`)  -- these are unmerged worktree outputs, usually from a conflict or crash.
3. Look at `run.json` for `done`, `lastError`, usage/cost fields.
4. If the thinking wave succeeded but orchestration crashed, `designs/` will still contain the architect docs  -- a resume will reuse them.
5. If rate-limited, the tool waits and retries on its own  -- do not kill it unless the user asks.

# What NOT to do

- Don't micromanage the tool. It has its own planner, steering, and goal refinement  -- trust them.
- Don't invent a resume procedure. The CLI handles resume itself; the correct action is almost always "re-run `claude-overnight` in the repo".
- Don't delete `.claude-overnight/` to "clean up"  -- it holds the only record of what the run learned. It should be in `.gitignore`.
- Don't truncate or summarize agent output files when reading them back  -- never discard expensive agent output.
- Don't confuse this with Vercel Workflow DevKit  -- unrelated despite the word "workflow".

# Playwright Parallel Usage

When agents use the Playwright MCP server for testing, parallel instances conflict on browser locks and cookie state. See `QUICKSHEET_PLAYWRIGHT.md` at the repo root for the full reference.

**Quick rules:**
- **Headless by default**  -- prevents focus stealing on macOS. Only use headed when anti-bot detection (CAPTCHA, Cloudflare) forces it
- **Isolated agents (no login):** Each MCP server needs `--isolated --headless`
- **Isolated agents (with saved login):** Each needs its own `userDataDir` or `--storage-state` file, plus `--headless`
- Multiple MCP entries in `settings.json`  -- one per concurrency slot, or use a single `--isolated` entry if cookies don't need to persist

**Context7 (ctx7) docs:** Requires authentication (`npx ctx7@latest login` or `CONTEXT7_API_KEY`). Pre-flight check:

```bash
npx ctx7@latest library playwright "parallel browser instances"
```

If this fails with a quota/auth error, fall back to training data  -- don't block the run.
