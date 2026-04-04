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

Describe your objective, set a budget, pick a model. The planner generates tasks — review, edit, or chat about them, then run.

### Task file

```bash
claude-overnight tasks.json
```

### Inline

```bash
claude-overnight "fix auth bug in src/auth.ts" "add tests for user model"
```

## How the planner scales

The budget isn't just a count — it changes how the planner thinks.

**Small budget (1-15)**: Specific, file-level tasks. "In `src/auth.ts`, refactor `validateToken()` to use JWT." Each task is a focused edit.

**Medium budget (16-50)**: Autonomous missions. "Design and implement the complete favorites system: DB schema, API routes, client hooks, error handling." Each agent researches and makes its own decisions.

**Large budget (50+)**: Full workstream decomposition. The planner thinks in terms of architecture, features, testing, security, UX polish, performance — everything a team would cover. Each task is a substantial work session for a 1M-context agent with 30 minutes of autonomy.

A budget of 200 is not 200 micro-edits. It's 200 senior-engineer work sessions running in parallel.

## Task file format

```json
{
  "tasks": [
    "Add input validation to all API routes",
    { "prompt": "Refactor database queries", "cwd": "./packages/api" }
  ],
  "model": "claude-sonnet-4-6",
  "concurrency": 4,
  "worktrees": true
}
```

A plain array also works: `["task one", "task two"]`.

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run |
| `model` | `string` | prompted | Model for all agents (per-task overridable) |
| `concurrency` | `number` | `5` | Max parallel agents |
| `worktrees` | `boolean` | auto (git repo) | Isolate each agent in a git worktree |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | How agents handle dangerous operations |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `allowedTools` | `string[]` | all | Restrict agent tools |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or a new branch |

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--budget=N` | `10` | Total agent sessions the planner targets |
| `--concurrency=N` | `5` | How many agents run simultaneously |
| `--model=NAME` | prompted | Model override |
| `--timeout=SECONDS` | `300` | Inactivity timeout (kills only silent agents) |
| `--dry-run` | — | Show planned tasks without running |
| `-h, --help` | — | Help |
| `-v, --version` | — | Version |

Budget = total work. Concurrency = pace. A budget of 100 with concurrency 5 means 100 tasks, 5 at a time.

## Rate limits and long runs

Built for unattended runs lasting hours, days, or weeks.

- **Hard block**: API returns a reset timestamp — swarm pauses and resumes exactly when the window opens.
- **Soft throttle**: at >75% utilization, dispatch slows to avoid hitting the limit.
- **Retry with backoff**: transient errors (429, overloaded, connection reset) retry with exponential backoff.

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
