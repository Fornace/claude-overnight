# claude-overnight

Fire off Claude agents, come back to shipped work.

Describe what to build. Set a budget — 10 agents, 100, 1000. A planner agent analyzes your codebase, breaks the objective into that many independent tasks, and launches them all. Each agent runs in its own git worktree with full tooling (Read, Edit, Bash, Grep — everything). Rate limits? It waits. Windows reset? It resumes. It doesn't stop until every task is done.

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

Describe your objective, set a budget, pick a worker model, set a usage limit. The planner generates tasks — review, edit, or chat about them, then run.

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

### Model-aware task design

The planner calibrates task ambition based on your worker model:

**Opus workers**: Each session is a powerhouse — it can own entire epics, do deep codebase research, make architectural decisions, implement complex multi-file systems, and use browser tools for analysis. The planner gives these agents full ownership and autonomy.

**Sonnet workers**: Capable of substantial implementation, refactoring, and testing. The planner gives meaningful missions with room for decision-making.

**Haiku workers**: Fast and efficient, best for focused tasks. The planner gives specific, well-scoped instructions with clear file paths and expected changes.

### Budget scaling

The budget also shapes task granularity:

**Small budget (1-15)**: Specific, file-level tasks. "In `src/auth.ts`, refactor `validateToken()` to use JWT."

**Medium budget (16-50)**: Autonomous missions. "Design and implement the complete favorites system: DB schema, API routes, client hooks, error handling."

**Large budget (50+)**: Full workstream decomposition. Architecture, features, testing, security, UX polish, performance — everything a team would cover. Each task is a substantial work session.

A budget of 200 is not 200 micro-edits. It's 200 senior-engineer work sessions running in parallel.

## Usage limits

Control how much of your plan capacity the run consumes. In interactive mode, you'll be asked:

```
Usage limit:
→ Unlimited — use full capacity, wait through rate limits
  90%       — leave 10% for other work
  75%       — conservative, plenty of headroom
  50%       — use half, keep the rest
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

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run |
| `model` | `string` | prompted | Worker model (per-task overridable) |
| `concurrency` | `number` | `5` | Max parallel agents |
| `worktrees` | `boolean` | auto (git repo) | Isolate each agent in a git worktree |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | How agents handle dangerous operations |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `allowedTools` | `string[]` | all | Restrict agent tools |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or a new branch |
| `usageCap` | `number` | unlimited | Stop at N% utilization (e.g. 90) |

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--budget=N` | `10` | Total agent sessions the planner targets |
| `--concurrency=N` | `5` | How many agents run simultaneously |
| `--model=NAME` | prompted | Worker model (planner always uses best available) |
| `--usage-cap=N` | unlimited | Stop at N% utilization |
| `--timeout=SECONDS` | `300` | Inactivity timeout (kills only silent agents) |
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
