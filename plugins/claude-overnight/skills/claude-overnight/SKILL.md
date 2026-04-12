---
name: claude-overnight
description: >
  Understand, install, and inspect claude-overnight runs — a CLI that
  launches parallel Claude agents in git worktrees with thinking waves,
  multi-wave steering, and crash-safe resume. Use when the user mentions
  claude-overnight, a `.claude-overnight/` folder, an "overnight" or
  "swarm" run, or asks to check status / resume / continue a
  multi-phase plan. Not for Vercel Workflow DevKit.
---

# What it is

`claude-overnight` is a CLI (npm: `claude-overnight`, bin: `claude-overnight`) that takes an objective + budget and runs many Claude agents in parallel, each in an isolated git worktree. It plans with a "thinking wave" of architect agents, orchestrates concrete tasks, executes waves, and uses steering to decide between more execution, reflection, or declaring done. Rate limits, crashes, and usage caps are all resumable — nothing is lost.

Repo: https://github.com/Fornace/claude-overnight

# Install / run

```bash
npm install -g claude-overnight      # Node >= 20; needs Claude auth or ANTHROPIC_API_KEY
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
| `goal.md`            | Evolving "north star" — what the run currently thinks "amazing" means.            |
| `milestones/*.md`    | Strategic snapshots archived ~every 5 waves. Long-term memory of the run.         |
| `designs/*.md`       | Architect outputs from the thinking wave. Deleted once the objective is complete. |
| `sessions/wave-N.json` | Per-wave agent records: prompt, status, cost, files changed, branch, error.    |

The newest subfolder under `runs/` is the current/last run. A run that never reached "done" is **resumable** — `run.json` will not be marked complete and `designs/` may still be present.

To assess status of a run from scratch, read in this order: `goal.md` → `status.md` → newest file in `milestones/` → newest `sessions/wave-*.json` → `run.json`. Five reads and you know exactly where it stands.

# Resume / continue

Just run `claude-overnight` again in the same repo. It auto-detects the unfinished run and shows a **Resume / Fresh / Quit** prompt. On resume: unmerged `swarm/task-*` branches auto-merge, the wave loop continues, status/goal/milestones/designs are preserved. If orchestration crashed after the thinking wave, surviving `designs/*.md` are reused — no re-paying for architects.

For **multi-phase plans** (task file with `objective` + `flexiblePlan: true`), resuming picks up at the next wave with full steering context. Don't hand-edit `run.json` to "fix" a stuck run unless something is demonstrably corrupt — prefer re-running and letting steering re-assess.

Merged branches from prior runs are not re-run. Knowledge carries forward across runs: new runs see what completed runs built.

# Diagnosing a stuck / failed run

1. Read `status.md` (living snapshot) and the newest `sessions/wave-*.json`.
2. Check for `swarm/task-*` branches left behind (`git branch --list 'swarm/*'`) — these are unmerged worktree outputs, usually from a conflict or crash.
3. Look at `run.json` for `done`, `lastError`, usage/cost fields.
4. If the thinking wave succeeded but orchestration crashed, `designs/` will still contain the architect docs — a resume will reuse them.
5. If rate-limited, the tool waits and retries on its own — do not kill it unless the user asks.

# What NOT to do

- Don't micromanage the tool. It has its own planner, steering, and goal refinement — trust them.
- Don't invent a resume procedure. The CLI handles resume itself; the correct action is almost always "re-run `claude-overnight` in the repo".
- Don't delete `.claude-overnight/` to "clean up" — it holds the only record of what the run learned. It should be in `.gitignore`.
- Don't truncate or summarize agent output files when reading them back — never discard expensive agent output.
- Don't confuse this with Vercel Workflow DevKit — unrelated despite the word "workflow".
