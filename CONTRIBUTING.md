# Contributing to claude-swarm

## Prerequisites

- **Node.js 20+**
- **Claude Code CLI** installed and authenticated (`claude` command available)
- Git (worktree features require a git repository)

## Development Setup

```bash
git clone https://github.com/Fornace/claude-swarm.git
cd claude-swarm
npm install
npm run dev    # watches src/ and recompiles on changes
```

To run your local build:

```bash
node dist/index.js                    # interactive mode
node dist/index.js tasks.json         # from task file
node dist/index.js "fix auth"         # inline task
```

Or link it globally during development:

```bash
npm link
claude-swarm
```

## Project Structure

```
src/
  index.ts     CLI entry point  -- arg parsing, interactive prompts, main loop
  swarm.ts     Core orchestrator  -- worker pool, agent lifecycle, worktree
               management, rate-limit throttling, auto-commit & merge
  planner.ts   Coordinator agent  -- analyzes the codebase and breaks an
               objective into independent parallel tasks
  ui.ts        Terminal UI  -- real-time dashboard with progress bar, agent
               table, token/cost stats, and event log (renders at 4fps)
  types.ts     Shared types  -- Task, AgentState, PermMode, SwarmPhase
```

**How it fits together:** `index.ts` collects config (model, concurrency, permissions) then either loads tasks from a file/args or delegates to `planner.ts` to generate them. It hands tasks to a `Swarm` instance which runs a concurrent worker pool via the Claude Agent SDK. `ui.ts` polls the swarm state and redraws the terminal. When worktrees are enabled, the swarm auto-commits each agent's changes and merges branches back at the end.

## Testing Locally

There's no test suite yet  -- contributions welcome! To verify your changes:

1. **Build check:** `npm run build` should compile with zero errors.
2. **Interactive mode:** run `node dist/index.js` and walk through the prompts.
3. **Task file:** run `node dist/index.js production-ready.json` (included in the repo) to exercise multi-agent execution.
4. **Dry validation:** review terminal UI output, rate-limit handling, and merge behavior with worktrees enabled.

Tip: use a small concurrency (2-3) and cheap tasks to keep costs low during testing.

## Submitting PRs

1. Create a feature branch from `main`.
2. Keep changes focused  -- one logical change per PR.
3. Run `npm run build` and verify there are no TypeScript errors.
4. Describe what changed and why in the PR description.
5. If you add new config options, update the help text in `index.ts` and the types in `types.ts`.
