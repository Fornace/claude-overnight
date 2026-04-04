# claude-overnight

Set a task budget, describe an objective, walk away. Come back to shipped work.

Tell it what to build. Set a budget — 10 tasks, 100, 1000, whatever the job needs. A planner agent analyzes your codebase and breaks the objective into that many independent tasks. Then they all run: parallel autonomous Claude Code agents, each in its own git worktree, each with full tooling (Read, Edit, Bash, grep, tests — everything). Rate limits hit? It waits. Windows reset? It resumes. It doesn't stop until every task is done or you tell it to.

## Install

```bash
npm install -g claude-overnight
```

Requires Node.js >= 20 and a valid Claude authentication (OAuth via `claude` CLI login, or `ANTHROPIC_API_KEY` env var).

## Quick start

### Interactive (planner mode)

```bash
claude-overnight
```

Describe your objective, set a task budget, pick a model. The planner generates the task breakdown — you can review, edit, chat about it, then run.

### Task file

```bash
claude-overnight tasks.json
```

### Inline tasks

```bash
claude-overnight "fix auth bug in src/auth.ts" "add tests for user model"
```

Each quoted argument becomes one parallel task.

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

A plain JSON array of strings also works: `["task one", "task two"]`.

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run in parallel |
| `model` | `string` | prompted | Model for all agents (per-task overridable) |
| `concurrency` | `number` | `5` | Max agents running simultaneously |
| `worktrees` | `boolean` | auto (git repo) | Isolate each agent in a git worktree |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | How agents handle dangerous operations |
| `cwd` | `string` | `process.cwd()` | Working directory for all agents |
| `allowedTools` | `string[]` | all | Restrict which tools agents can use |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or into a new branch |

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--budget=N` | `10` | How many tasks the planner generates — the total size of the run |
| `--concurrency=N` | `5` | How many agents run at the same time (budget = total, concurrency = pace) |
| `--model=NAME` | — | Model override for all agents |
| `--timeout=SECONDS` | `300` | Agent inactivity timeout (kills only silent agents) |
| `--dry-run` | — | Show planned tasks without executing them |
| `-h, --help` | — | Show help |
| `-v, --version` | — | Print version |

## Rate limits and long runs

claude-overnight is built to run unattended for hours, days, weeks, or months. It handles API rate limits without supervision:

- **Hard block**: when the API rejects a request and returns a reset timestamp, the swarm pauses and resumes exactly when the window opens.
- **Soft throttle**: at >75% utilization, dispatch slows proactively to avoid hitting the limit.
- **Retry with backoff**: transient errors (429, overloaded, connection reset) retry with exponential backoff.

No tasks are dropped. Set a budget of 1000, go to sleep, and it will work through every rate limit window until the run is complete.

## Worktrees and merging

Each agent runs in an isolated git worktree on a `swarm/task-N` branch. Changes are auto-committed when the agent finishes. After all agents complete, branches merge back sequentially. The default `"yolo"` strategy merges directly into your current branch; `"branch"` creates a new `swarm/run-{timestamp}` branch instead. Merge conflicts retry with `-X theirs`; if that still fails, the branch is preserved for manual resolution. Stale worktrees and orphaned `swarm/*` branches from previous runs are cleaned up automatically on startup.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tasks succeeded |
| `1` | Some tasks failed |
| `2` | All tasks failed or no tasks completed |
