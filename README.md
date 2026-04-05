# claude-overnight

Run 10, 100, or 1000 Claude agents overnight. Come back to shipped work.

Describe what to build. Set a budget. The tool plans, explores your codebase, breaks the objective into tasks, launches parallel agents in isolated git worktrees, iterates toward quality, and handles rate limits automatically. You press Run once, then go to sleep.

Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Works with Claude Opus, Sonnet, and Haiku.

## Install

```bash
npm install -g claude-overnight
```

Requires Node.js >= 20 and Claude authentication (`claude auth login`, or set `ANTHROPIC_API_KEY`).

## Quick start

```bash
claude-overnight
```

```
🌙  claude-overnight
────────────────────────────────────

① What should the agents do?
  > refactor auth, add tests, update docs

② Budget [10]: 200

③ Worker model:
  ● Sonnet — Sonnet 4.6 · Best for everyday tasks
  ○ Opus — Opus 4.6 · Most capable

④ Usage:
  ● 90% · leave 10% for other work

╭──────────────────────────────────────────╮
│  sonnet · budget 200 · 5× · flex · 90%  │
╰──────────────────────────────────────────╯

✓ 5 themes → review, press Run, walk away

◆ Thinking: 5 agents exploring...     ← architects analyze your codebase
◆ Orchestrating plan...               ← synthesizes 50 concrete tasks
◆ Wave 1 · 50 tasks                   ← fully autonomous from here
◆ Assessing... how close to amazing?
◆ Wave 2 · 30 tasks                   ← improvements from assessment
◆ Reflection: 2 agents reviewing      ← deep quality audit
◆ Wave 3 · 20 tasks                   ← fixes from review findings
◆ Assessing... ✓ Vision met
```

You interact once (objective, budget, model, review themes), then everything runs autonomously — thinking, planning, executing, reflecting, steering. Rate-limited? It waits and retries. Crash? Resume where you left off.

## How it works

### 1. Thinking wave

For budgets > 15, the tool launches **architect agents** that explore your codebase before any code is written. Each one gets a different research angle (architecture, data models, APIs, testing, etc.) and writes a structured design document. The number scales with budget: 5 for budget=50, 10 for budget=2000.

### 2. Orchestration

An orchestrator agent reads all design documents and synthesizes concrete execution tasks — grounded in real files and patterns the architects found. No guesswork.

### 3. Iterative execution

Tasks run in parallel (each agent in its own git worktree). After each wave, steering assesses: "how good is this?" — not "what's missing?" It can:

- **Execute** more tasks to build features, fix bugs, polish UX
- **Reflect** by spinning up 1-2 review agents for deep quality/architecture audits
- **Declare done** when the vision is met at high quality

### 4. Goal refinement

The tool starts with your broad objective but evolves its definition of "amazing" as it learns your codebase. Steering refines the goal after each wave. Late waves are informed by early discoveries.

### 5. Three-layer context

Long runs stay sharp because steering maintains three layers of memory:

- **Status** — a living project snapshot, updated every wave. Compressed, never truncated.
- **Milestones** — strategic snapshots archived every ~5 waves. Long-term memory.
- **Goal** — the evolving north star. What "amazing" means for this codebase.

## Run history and resume

Every run gets its own folder in `.claude-overnight/runs/`. Nothing is ever overwritten.

```
.claude-overnight/
  runs/
    2026-04-04T18-52-49/     ← run A (done, $200, 200 tasks)
      run.json, status.md, goal.md, milestones/, sessions/
    2026-04-05T10-30-00/     ← run B (crashed)
      run.json, sessions/
```

If a run crashes, gets rate-limited, or you Ctrl+C:

```
  ⚠ Interrupted run
  ╭──────────────────────────────────────────────────╮
  │  refactor auth, add tests, update docs           │
  │  50/200 sessions · 3 waves · $69.16              │
  │  34 merged · 16 unmerged · 0 failed branches     │
  ╰──────────────────────────────────────────────────╯

  Resume  │  Fresh  │  Quit
```

On resume: unmerged branches auto-merge, the wave loop continues, all context is preserved.

**Knowledge carries forward** — new runs inherit knowledge from completed previous runs. Thinking agents and steering see what past runs built. Run 2 knows run 1 already built the auth system.

Add `.claude-overnight` to your `.gitignore`.

## Other usage modes

### Task file

```bash
claude-overnight tasks.json
```

```json
{
  "tasks": [
    "Add input validation to all API routes",
    { "prompt": "Refactor database queries", "cwd": "./packages/api" }
  ],
  "model": "claude-sonnet-4-6",
  "concurrency": 4,
  "worktrees": true,
  "usageCap": 90
}
```

For multi-wave runs, add `objective` and `flexiblePlan`:

```json
{
  "objective": "Modernize the auth system",
  "flexiblePlan": true,
  "tasks": ["Refactor auth middleware", "Add JWT validation"],
  "usageCap": 90
}
```

### Inline

```bash
claude-overnight "fix auth bug in src/auth.ts" "add tests for user model"
```

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--budget=N` | `10` | Total agent sessions |
| `--concurrency=N` | `5` | Parallel agents |
| `--model=NAME` | prompted | Worker model (planner uses best available) |
| `--usage-cap=N` | unlimited | Stop at N% utilization |
| `--timeout=SECONDS` | `300` | Inactivity timeout per agent |
| `--no-flex` | — | Disable multi-wave steering |
| `--dry-run` | — | Show planned tasks without running |

## Task file fields

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run |
| `objective` | `string` | — | High-level goal for steering |
| `flexiblePlan` | `boolean` | `false` | Enable multi-wave planning |
| `model` | `string` | prompted | Worker model |
| `concurrency` | `number` | `5` | Parallel agents |
| `worktrees` | `boolean` | auto | Git worktree isolation |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | Permission handling |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or new branch |
| `usageCap` | `number (0-100)` | unlimited | Stop at N% utilization |

## Rate limits

Built for unattended runs lasting hours or days.

- **Hard block**: pauses until the rate limit window resets, then resumes
- **Soft throttle**: slows dispatch at >75% utilization
- **Retry with backoff**: transient errors (429, overloaded) retry automatically
- **Usage cap**: set a ceiling, active agents finish, no new ones start
- **Planner retries**: steering and orchestration also retry on rate limits (30s/60s/120s backoff)

## Worktrees and merging

Each agent gets an isolated git worktree (`swarm/task-N` branch). Changes auto-commit. After all agents complete, branches merge back.

- `"yolo"` (default): merges into your current branch
- `"branch"`: creates a new `swarm/run-{timestamp}` branch

Conflicts retry with `-X theirs`. Unresolved branches are preserved for manual merge.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tasks succeeded |
| `1` | Some tasks failed |
| `2` | All failed or none completed |

## License

MIT
