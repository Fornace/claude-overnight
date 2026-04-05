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

④ Usage cap:
  ● 90% · leave 10% for other work

⑤ Allow extra usage (billed separately):
  ● No · stop when plan limits are reached

╭──────────────────────────────────────────────────╮
│  sonnet · budget 200 · 5× · flex · cap 90% · no extra  │
╰──────────────────────────────────────────────────╯

⠹ 8s · $0.04 · 12% · identifying themes   ← every phase shows cost + usage
✓ 5 themes → review, press Run, walk away

◆ Thinking: 5 agents exploring...         ← architects analyze your codebase
◆ Orchestrating plan...                   ← synthesizes 50 concrete tasks
◆ Wave 1 · 50 tasks · $4.20 spent        ← fully autonomous from here
◆ Assessing... how close to amazing?
◆ Wave 2 · 30 tasks · $18.50 spent       ← improvements from assessment
◆ Reflection: 2 agents reviewing          ← deep quality audit
◆ Wave 3 · 20 tasks · $31.00 spent       ← fixes from review findings
◆ Assessing... ✓ Vision met
```

You interact once (objective, budget, model, review themes), then everything runs autonomously — thinking, planning, executing, reflecting, steering. Rate-limited? It waits and retries. Crash? Resume where you left off. Capped at usage limit? Pick up next time with full context preserved.

## How it works

### 1. Thinking wave

For budgets > 15, the tool launches **architect agents** that explore your codebase before any code is written. Each one gets a different research angle (architecture, data models, APIs, testing, etc.) and writes a structured design document. The number scales with budget: 5 for budget=50, 10 for budget=2000.

### 2. Orchestration

An orchestrator agent reads all design documents and synthesizes concrete execution tasks — grounded in real files and patterns the architects found. No guesswork. The task plan is also written to a file for resilience — if orchestration is interrupted, partial results survive.

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

Any run that stops before the steering system declares the objective complete — capped at usage limit, Ctrl+C, crash, rate limit timeout, steering failure — is automatically resumable:

```
  ⚠ Unfinished run
  ╭──────────────────────────────────────────────────╮
  │  refactor auth, add tests, update docs           │
  │  50/200 sessions · 150 remaining · $69.16        │
  │  34 merged · 16 unmerged · 0 failed branches     │
  ╰──────────────────────────────────────────────────╯

  Resume  │  Fresh  │  Quit
```

On resume: unmerged branches auto-merge, the wave loop continues, all context is preserved. Designs and reflections stay on disk until the objective is truly complete.

If the thinking phase succeeds but orchestration crashes, the next run detects the orphaned design docs and reuses them — no re-running $9 worth of architect agents:

```
  ✓ Reusing 5 design docs (from prior attempt)
    Focus 0: Project Wizard UI vs VISION.md Flow
    Focus 1: Team Load and Rebalancer Surface
    Focus 2: Code Health After Swarm Wave
    ...
```

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
| `--allow-extra-usage` | off | Allow extra/overage usage (billed separately) |
| `--extra-usage-budget=N` | — | Max $ for extra usage (implies --allow-extra-usage) |
| `--timeout=SECONDS` | `900` | Inactivity timeout per agent (nudges at timeout, kills at 2×) |
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

## Usage controls

### Extra usage protection

By default, extra/overage usage is **blocked**. When your plan's rate limits are exhausted, the run stops cleanly and is resumable. You control this in the interactive prompt (step ⑤) or via CLI flags:

- `--allow-extra-usage` — opt in to extra usage (billed separately)
- `--extra-usage-budget=20` — allow up to $20 of extra usage, then stop

### Live controls during execution

Press these keys while agents are running:

| Key | Action |
|---|---|
| `b` | Change remaining budget (number of sessions) |
| `t` | Change usage cap threshold (0-100%) |
| `q` | Graceful stop (press twice to force quit) |

Changes take effect between waves — active agents finish their current task.

### Multi-window usage display

The usage bar cycles through all rate limit windows (5h, 7d, etc.) every 3 seconds, showing utilization per window. Usage info is shown during all phases — thinking, orchestration, steering, and execution.

## Rate limits

Built for unattended runs lasting hours or days.

- **Smooth overage transition**: when extra usage is allowed, plan limit rejection is seamless — no dispatch blocking, agents continue into overage
- **Interrupt + resume**: agents and planner queries that go silent are interrupted and resumed with full conversation context via SDK session resume — not killed and restarted from scratch
- **Hard block**: pauses until the rate limit window resets, then resumes
- **Soft throttle**: slows dispatch at >75% utilization
- **Extra usage guard**: detects overage billing and stops unless explicitly allowed
- **Cooldown between phases**: waits for rate limit reset after thinking before starting orchestration
- **Retry with backoff**: transient errors (429, overloaded) retry automatically
- **Usage cap**: set a ceiling, active agents finish, no new ones start — run is resumable
- **Planner retries**: steering and orchestration retry on rate limits (30s/60s/120s backoff) with full context

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
