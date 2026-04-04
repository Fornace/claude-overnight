# claude-swarm

Run parallel Claude Code agents with a real-time terminal UI. Give it an objective and it plans, executes, and merges — or feed it explicit tasks.

```
  CLAUDE SWARM          ████████████░░░░  4/6  2 active  0 queued  ⏱ 1m 23s
  ↑ 1.2M in  ↓ 340K out  $0.847  RL 42%

  #   Status   Task                              Action
  ─────────────────────────────────────────────────────────────────
    0  ⟳ run   Refactor auth middleware           Edit
    1  ⟳ run   Add rate limiting to /api/users    Bash
    2  ✓ done  Fix CORS headers in proxy          38s $0.12 3f
    3  ✓ done  Add input validation to forms      52s $0.21 5f
```

## Install

```bash
npm install -g claude-swarm
```

## Usage

Three modes: **interactive**, **task file**, and **inline**.

### Interactive (planner mode)

```bash
claude-swarm
```

You pick a model, concurrency, and permission mode, then describe what you want. A planner agent analyzes your codebase and breaks the objective into independent parallel tasks.

### Task file

```bash
claude-swarm tasks.json
```

```json
{
  "model": "claude-sonnet-4-6",
  "concurrency": 5,
  "worktrees": true,
  "permissionMode": "auto",
  "tasks": [
    "Add input validation to all API routes",
    "Write unit tests for the auth module",
    { "prompt": "Refactor database queries in src/db/", "cwd": "./packages/api" },
    { "prompt": "Update the README with new API docs", "model": "claude-haiku-4" }
  ]
}
```

Tasks can be strings or objects with `prompt`, `cwd`, and `model` overrides. A plain JSON array of strings also works:

```json
["fix the login bug", "add tests for signup", "update error messages"]
```

### Inline tasks

```bash
claude-swarm "fix auth bug in src/auth.ts" "add tests for user model"
```

Each quoted argument becomes one parallel task.

## Task file options

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run in parallel |
| `model` | `string` | prompted | Model for all agents (overridden per-task) |
| `concurrency` | `number` | `5` | Max agents running simultaneously |
| `worktrees` | `boolean` | prompted | Isolate each agent in a git worktree |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | prompted | How agents handle dangerous operations |
| `cwd` | `string` | `process.cwd()` | Working directory for all agents |
| `allowedTools` | `string[]` | all | Restrict which tools agents can use |

## How it works

```
objective
    │
    ▼
┌─────────┐    Analyzes codebase, breaks objective
│ Planner  │    into independent tasks (Read, Glob, Grep, Bash)
└────┬────┘
     │ tasks[]
     ▼
┌─────────┐    Runs N agents concurrently with
│  Swarm   │    rate-limit-aware throttling
└────┬────┘
     │ spawns
     ▼
┌──────────────────────────────┐
│  Agent 0  │  Agent 1  │ ...  │    Each in its own git worktree
│  (query)  │  (query)  │      │    with full Claude Code tools
└──────┬───────────┬───────────┘
       │ auto-commit per worktree
       ▼
┌─────────┐    Sequential merge of all branches
│  Merge   │    into HEAD, with conflict detection
└─────────┘
```

**Without worktrees:** agents all work in the same directory. Simpler, but risks conflicts on concurrent file edits. Best for tasks targeting different files.

**With worktrees:** each agent gets an isolated `git worktree` branch (`swarm/task-N`). Changes are auto-committed and merged back sequentially. Merge conflicts are reported — failed branches are preserved for manual resolution.

## Rate limit handling

The swarm tracks rate limit utilization from the API and adapts automatically:

- **> 75% utilization** — adds proportional delays between agent launches
- **Rejected** — pauses all new agents until the reset window passes
- The UI shows real-time rate limit percentage with color coding (green/yellow/red)

## Permission modes

| Mode | Behavior |
|---|---|
| `auto` | AI decides what's safe (recommended) |
| `bypassPermissions` | Skip all permission prompts (use with caution) |
| `default` | Prompt for every dangerous operation |

## Authentication

claude-swarm uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) which handles auth automatically:

- **Claude Max/Pro subscribers** — OAuth via `claude` CLI login, no setup needed
- **API key** — set `ANTHROPIC_API_KEY` in your environment

The available models are fetched from your account at startup.

## Terminal UI

The real-time display (refreshed 4x/second) shows:

- **Progress bar** with completed/total count
- **Token usage** (input/output) and **running cost**
- **Rate limit utilization** percentage
- **Agent table** — status, current tool call, duration, cost, files changed
- **Merge results** — success/conflict per branch
- **Event log** — last 10 events across all agents

## Development

```bash
git clone https://github.com/Fornace/claude-swarm
cd claude-swarm
npm install
npm run build
node dist/index.js
```
