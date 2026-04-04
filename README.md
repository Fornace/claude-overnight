# claude-overnight

Fire off Claude agents, come back to shipped work.

Describe what to build. Set a budget — 10 agents, 100, 1000. A planner agent analyzes your codebase, breaks the objective into independent tasks, and launches them all. Each agent runs in its own git worktree with full tooling (Read, Edit, Bash, Grep — everything). Rate limits? It waits. Windows reset? It resumes. It doesn't stop until every task is done.

## Install

```bash
npm install -g claude-overnight
```

Requires Node.js >= 20 and Claude authentication (OAuth via `claude` CLI, or `ANTHROPIC_API_KEY`).

## Usage

### Interactive

```bash
claude-overnight
```

A guided flow walks you through each step:

```
🌙  claude-overnight
────────────────────────────────────

① What should the agents do?
  > refactor auth, add tests, update docs

② Budget [10]: 50

③ Worker model:
  ● Sonnet — Sonnet 4.6 · Best for everyday tasks
  ○ Opus — Opus 4.6 · Most capable
  ○ Haiku — Haiku 4.5 · Fastest

④ Usage:
  ● Unlimited · full capacity, wait through rate limits
  ○ 90% · leave 10% for other work

╭────────────────────────────────────╮
│  sonnet · budget 50 · 5× · flex   │
╰────────────────────────────────────╯
```

For large budgets, the planner identifies research themes — review them, then press Run. Everything after that is fully autonomous: thinking agents explore, the orchestrator synthesizes tasks, execution waves run, and steering adapts between waves. No further interaction needed — go to sleep.

### Task file

```bash
claude-overnight tasks.json
```

### Inline

```bash
claude-overnight "fix auth bug in src/auth.ts" "add tests for user model"
```

## How the planner works

The planner always runs on the best available model (Opus) regardless of which model you pick for workers. This ensures high-quality task decomposition even when workers use a cheaper model.

### Thinking wave

For large budgets (`budget > concurrency * 3`), the planner doesn't try to generate hundreds of tasks from scratch. Instead, it launches a **thinking wave** — a team of architect agents that explore your codebase in parallel before any code is written.

```
⠋ identifying themes...          → splits objective into N angles (< 30s)
✓ 10 themes                      → review themes, press Run, walk away
◆ Thinking: 10 agents exploring  → each explores from its angle, writes a design doc
◆ Orchestrating plan...          → reads all design docs, synthesizes execution tasks
◆ Wave 1 · 50 tasks              → fully autonomous from here
◆ Steering...                    → adapts between waves, retries on rate limits
```

The review prompt appears right after theme identification — the last thing requiring your presence. After you press Run, the thinking wave, orchestration, execution, and steering all run autonomously. Rate-limited? The planner waits and retries. Go to sleep.

The number of thinking agents scales with budget: 5 for budget=50, 10 for budget=2000+. Each agent explores the codebase from a different angle and writes a structured design document. The orchestrator then reads all design docs and produces grounded execution tasks referencing real files and patterns.

For small budgets (≤ `concurrency * 3`), the planner skips the thinking wave and generates tasks directly — fast and efficient for focused work.

### Model-aware task design

The planner calibrates task ambition based on your worker model:

**Opus workers**: Each session is a powerhouse — it can own entire epics, do deep codebase research, make architectural decisions, implement complex multi-file systems, and use browser tools for analysis. The planner gives these agents full ownership and autonomy.

**Sonnet workers**: Capable of substantial implementation, refactoring, and testing. The planner gives meaningful missions with room for decision-making.

**Haiku workers**: Fast and efficient, best for focused tasks. The planner gives specific, well-scoped instructions with clear file paths and expected changes.

### Budget scaling

The budget also shapes task granularity:

**Small budget (1-15)**: Specific, file-level tasks. "In `src/auth.ts`, refactor `validateToken()` to use JWT."

**Medium budget (16-50)**: Autonomous missions. "Design and implement the complete favorites system: DB schema, API routes, client hooks, error handling."

**Large budget (50+)**: Thinking wave + orchestration. Architects explore, then execution tasks are synthesized from their findings. Each task is a substantial work session grounded in real codebase analysis.

A budget of 200 is not 200 micro-edits. It's ~5 architects + ~195 senior-engineer work sessions, planned in waves. A budget of 2000 gets 10 architects.

## Usage limits

Control how much of your plan capacity the run consumes:

```
④ Usage:
  ● Unlimited · full capacity, wait through rate limits
  ○ 90% · leave 10% for other work
  ○ 75% · conservative, plenty of headroom
  ○ 50% · use half, keep the rest
```

When utilization hits your cap, the swarm stops dispatching new tasks and lets active agents finish gracefully. This way you can run a big overnight job and still have capacity left for manual Claude usage.

Use `--usage-cap=90` on the command line, or `"usageCap": 90` in task files.

## Task file format

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

A plain array also works: `["task one", "task two"]`.

For multi-wave runs from a task file, add `objective` and `flexiblePlan`:

```json
{
  "objective": "Modernize the auth system and add comprehensive tests",
  "flexiblePlan": true,
  "tasks": ["Refactor auth middleware", "Add JWT validation"],
  "usageCap": 90
}
```

The initial tasks run first. After each wave, a steering agent reads the codebase and plans the next wave until the objective is met or the budget runs out.

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run |
| `objective` | `string` | — | High-level goal for multi-wave steering (required when `flexiblePlan` is true) |
| `flexiblePlan` | `boolean` | `false` | Enable adaptive multi-wave planning from task files |
| `model` | `string` | prompted | Worker model (per-task overridable) |
| `concurrency` | `number` | `5` | Max parallel agents |
| `worktrees` | `boolean` | auto (git repo) | Isolate each agent in a git worktree |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | How agents handle dangerous operations |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `allowedTools` | `string[]` | all | Restrict agent tools |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or a new branch |
| `usageCap` | `number (0-100)` | unlimited | Stop at N% utilization (e.g. 90) |

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--budget=N` | `10` | Total agent sessions the planner targets |
| `--concurrency=N` | `5` | How many agents run simultaneously |
| `--model=NAME` | prompted | Worker model (planner always uses best available) |
| `--usage-cap=N` | unlimited | Stop at N% utilization |
| `--timeout=SECONDS` | `300` | Inactivity timeout (kills only silent agents) |
| `--no-flex` | — | Disable adaptive multi-wave planning (run all tasks in one shot) |
| `--dry-run` | — | Show planned tasks without running |
| `-h, --help` | — | Help |
| `-v, --version` | — | Version |

Budget = total work. Concurrency = pace. A budget of 100 with concurrency 5 means 100 tasks, 5 at a time.

## Rate limits and long runs

Built for unattended runs lasting hours, days, or weeks.

- **Usage bar**: the live UI shows current utilization with a visual bar, percentage, and countdown to reset when rate-limited.
- **Hard block**: API returns a reset timestamp — swarm pauses and resumes exactly when the window opens.
- **Soft throttle**: at >75% utilization, dispatch slows to avoid hitting the limit.
- **Retry with backoff**: transient errors (429, overloaded, connection reset) retry with exponential backoff.
- **Usage cap**: set a ceiling and the swarm stops dispatching when it's reached — active agents finish, no new ones start.

No tasks are dropped. Set a budget of 1000 and go to sleep.

## Worktrees and merging

Each agent gets an isolated git worktree on a `swarm/task-N` branch. Changes auto-commit when the agent finishes. After all agents complete, branches merge back sequentially.

- `"yolo"` (default): merges directly into your current branch
- `"branch"`: creates a `swarm/run-{timestamp}` branch (main untouched)

Merge conflicts retry with `-X theirs`. If that fails, the branch is preserved for manual resolution. Stale worktrees and `swarm/*` branches from previous runs are cleaned up on startup.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tasks succeeded |
| `1` | Some tasks failed |
| `2` | All failed or none completed |
