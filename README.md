# claude-overnight

Run parallel Claude Code agents with a real-time terminal UI.

Give it an objective and it plans, executes, and merges the results — or feed it explicit tasks. Each agent gets full Claude Code tooling (Read, Edit, Bash, etc.) and optionally runs in an isolated git worktree. A live TUI shows progress, cost, rate limits, and per-agent status.

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

Prompts for model, concurrency, and permission mode, then asks for an objective. A planner agent analyzes your codebase and breaks it into parallel tasks.

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

A JSON file with a `tasks` array and optional configuration:

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
| `worktrees` | `boolean` | prompted | Isolate each agent in a git worktree |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | How agents handle dangerous operations |
| `cwd` | `string` | `process.cwd()` | Working directory for all agents |
| `allowedTools` | `string[]` | all | Restrict which tools agents can use |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or into a new branch |

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--concurrency=N` | `5` | Max parallel agents (overrides task file) |
| `--model=NAME` | — | Model override for all agents |
| `--timeout=SECONDS` | `300` | Agent inactivity timeout (kills only silent agents) |
| `--dry-run` | — | Show planned tasks without executing them |

## Worktrees and merging

When worktrees are enabled, each agent runs in an isolated git worktree on a `swarm/task-N` branch. Changes are auto-committed when the agent finishes. After all agents complete, branches are merged back sequentially. The default `"yolo"` strategy merges directly into your current branch; `"branch"` creates a new `swarm/run-{timestamp}` branch instead. If a merge conflicts, the swarm retries with `-X theirs`; if that still fails, the branch is preserved for manual resolution. Stale worktrees and orphaned `swarm/*` branches from previous runs are cleaned up automatically on startup.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tasks succeeded |
| `1` | Some tasks failed |
| `2` | All tasks failed or no tasks completed |
