# claude-overnight

**A background lane for your Claude Max plan.** Runs a capped swarm of Claude Agent SDK sessions in isolated git worktrees — stops at a usage cap you set, so your interactive Claude Code always has headroom. Rate-limited? It waits. Crash? It resumes with full context.

Your Max plan rate limits eat interactive coding time. One deep refactor and the 5-hour window is gone before lunch. `claude-overnight` runs background agent sessions up to the percentage cap you pick (90% is typical), leaving the rest free for your own Claude Code session. Hand it an objective and a session budget, walk away, review the diff when the run ends.

Isolated by default. Every agent runs in its own git worktree on its own branch, so a misbehaving agent can't trash your working tree. You choose what agents can do before the run starts — no surprise escalation mid-flight. Unmerged branches are preserved for manual review, never discarded. Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — not a Claude Code replacement, but a background lane that runs alongside it.

Different shape from hosted agent harnesses like [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview): instead of one agent in one cloud container billed separately, you get many parallel sessions on your own machine, in your real repo, against your own Max plan (or API key). Works with Claude Opus, Sonnet, and Haiku — or pair an Anthropic planner with a cheaper executor on Qwen, OpenRouter, or any Anthropic-compatible endpoint.

## Run on Qwen 3.6 Plus

Hit your Claude Max plan limits? Running on a tight budget? Qwen 3.6 Plus via Alibaba Cloud's DashScope gateway is a drop-in executor that speaks the Anthropic Messages API — same client, same flow, pennies per run.

1. **Get an API key.** Sign up at [Alibaba Cloud](https://account.alibabacloud.com/login/login.htm?oauth_callback=https%3A%2F%2Fmodelstudio.console.alibabacloud.com%2Fap-southeast-1%3Ftab%3Ddashboard%23%2Fapi-key&clearRedirectCookie=1) — the link takes you straight to the API key dashboard.
2. **Configure the provider.** Run `claude-overnight`, choose `Other…` on the executor step, and fill in:

   | Field | Value |
   |---|---|
   | Name | `Qwen 3.6 Plus` |
   | Base URL | `https://dashscope-intl.aliyuncs.com/apps/anthropic` |
   | Model id | `qwen3.6-plus` |
   | API key | your DashScope key |

3. That's it. Planner runs on Sonnet (or Opus), executor runs on Qwen.

Or set it via env directly:

```bash
export ANTHROPIC_BASE_URL="https://dashscope-intl.aliyuncs.com/apps/anthropic"
export ANTHROPIC_API_KEY="sk-..."
export ANTHROPIC_MODEL="qwen3.6-plus"
claude-overnight
```

## Install

```bash
npm install -g claude-overnight
```

Requires Node.js ≥ 20 and Claude authentication (`claude auth login` or `ANTHROPIC_API_KEY`). No Anthropic plan or key? See **Run on Qwen 3.6 Plus** above — a cheap, drop-in alternative.

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

④ Planner model (thinking, steering — use your strongest):
  ● Opus — Opus 4.6 · Most capable
  ○ Sonnet — Sonnet 4.6 · Best for everyday tasks

⑤ Executor model (what runs the tasks — Qwen 3.6 Plus / OpenRouter / etc via Other…):
  ● Sonnet — Sonnet 4.6 · Best for everyday tasks
  ○ Opus — Opus 4.6 · Most capable
  ○ Other… · custom OpenAI/Anthropic-compatible endpoint

⑥ Usage cap:
  ● 90% · leave 10% for other work

⑦ Allow extra usage (billed separately):
  ● No · stop when plan limits are reached

╭──────────────────────────────────────────────────╮
│  sonnet · budget 200 · 5× · flex · cap 90% · no extra  │
╰──────────────────────────────────────────────────╯

⠹ 8s · $0.04 · 12% · identifying themes   ← every phase shows cost + usage
✓ 5 themes → review, press Run, walk away

◆ Thinking: 5 agents exploring...         ← architects analyze your codebase
◆ Orchestrating plan...                   ← synthesizes 50 concrete tasks
◆ Wave 1 · 50 tasks · $4.20 spent        ← runs unattended from here
  ↑ 1.2M in  ↓ 340K out  $4.20 / $4.24 total
◆ Assessing... how close to amazing?
◆ Wave 2 · 30 tasks · $18.50 spent       ← improvements from assessment
◆ Reflection: 2 agents reviewing          ← deep quality audit
◆ Wave 3 · 20 tasks · $31.00 spent       ← fixes from review findings
◆ Assessing... ✓ Done
```

You interact once (objective, budget, model, review themes), then the rest runs unattended — thinking, planning, executing, reflecting, steering. Rate-limited? It waits and retries. Crash? Resume where you left off. Capped at usage limit? Pick up next time with full context preserved.

## How it differs

- vs **Claude Code**: many agents, no driver, capped so your Claude Code session keeps its headroom
- vs **[Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)**: on your machine, against your Max plan, in your real git history — not a cloud container billed separately
- vs **Cursor / Copilot / Cline**: asynchronous, off the keyboard

## Use cases

- **Overnight refactors** — "Modernize the auth system" at budget 200.
- **Batch feature implementation** — dozens of features from a task file, parallelized.
- **Codebase-wide cleanups** — deduplicate, simplify, rename, normalize.
- **Test generation at scale** — integration tests for every route or module.
- **Documentation sprints** — API docs, READMEs, inline comments, changelogs.
- **Framework migrations** — version upgrades, type annotations, config format swaps.
- **Quality audits** — reflection waves surface architectural issues and code smells.
- **Long research runs** — architect sessions explore a large codebase before any code lands.

Typical shape: one objective + a $20–$200 spend cap + walk away.

## How it works

### 1. Thinking phase — parallel architect sessions

For budgets > 15, the tool launches **architect agents** that explore your codebase before any code is written. Each one gets a different research angle (architecture, data models, APIs, testing, etc.) and writes a structured design document. The number scales with budget: 5 for budget=50, 10 for budget=2000.

### 2. Task orchestration

An orchestrator session reads all design documents and synthesizes concrete execution tasks — grounded in real files and patterns the architects found. The task plan is also written to a file for resilience — if orchestration is interrupted, partial results survive.

### 3. Parallel execution waves

Tasks run in parallel agent sessions (each in its own git worktree). After completing its task, each session automatically runs a **simplify pass** — reviewing its own `git diff` for code reuse opportunities, quality issues, and inefficiencies, then fixing them before the framework commits.

After each wave, steering assesses: "how good is this?" — not "what's missing?" It can:

- **Execute** more tasks to build features, fix bugs, polish UX
- **Reflect** by spinning up 1-2 review sessions for deep quality/architecture audits
- **Declare done** when the vision is met at high quality

### 4. Goal refinement and steering

The tool starts with your broad objective but refines its definition of quality as it learns your codebase. Steering updates the goal after each wave. Late waves are informed by early discoveries.

### 5. Three-layer context memory

Long runs stay sharp because steering maintains three layers of memory:

- **Status** — a living project snapshot, updated every wave. Compressed, never truncated.
- **Milestones** — strategic snapshots archived every ~5 waves. Long-term memory.
- **Goal** — the evolving north star. What quality means for this codebase.

## Run history, resume, and knowledge carryforward

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

If the thinking phase succeeds but orchestration crashes, the next run detects the orphaned design docs and reuses them — no re-running $9 worth of architect sessions:

```
  ✓ Reusing 5 design docs (from prior attempt)
    Focus 0: Project Wizard UI vs VISION.md Flow
    Focus 1: Team Load and Rebalancer Surface
    Focus 2: Code Health After Swarm Wave
    ...
```

**Knowledge carries forward** — new runs inherit knowledge from completed previous runs. Thinking sessions and steering see what past runs built. Run 2 knows run 1 already built the auth system.

Add `.claude-overnight/` to your `.gitignore` (with the trailing slash — see below).

A separate, tiny `claude-overnight.log.md` is also written at the repo root on every run. It's human-readable, append-only, one block per run (objective, start/finish, cost, outcome, branch), and is designed to be **committed** — so even after `.claude-overnight/` is cleaned up you can still recover which prompt produced which commits. Use `.claude-overnight/` (with trailing slash) in your gitignore so this file isn't matched by accident.

## Task file and inline modes

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

Inline:

```bash
claude-overnight "fix auth bug in src/auth.ts" "add tests for user model"
```

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--budget=N` | `10` | Total agent sessions |
| `--concurrency=N` | `5` | Parallel agents |
| `--model=NAME` | prompted | Worker model — interactive picks planner + executor separately; `Other…` adds Qwen / OpenRouter / any Anthropic-compat endpoint. In non-interactive mode, a saved provider's model id is auto-resolved to the provider. |
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

## Custom providers (Qwen, OpenRouter, any Anthropic-compatible endpoint)

Planner and executor are picked separately — pair Opus-on-Anthropic for the planner/thinker with a cheaper model on another provider for the bulk of execution.

From the interactive picker, choose `Other…` on the planner or executor step:

```
⑤ Executor model (what runs the tasks — Qwen 3.6 Plus / OpenRouter / etc via Other…):
  ○ Sonnet
  ○ Opus
  ● Other…

  Name: Qwen 3.6 Plus
  Base URL: https://dashscope-intl.aliyuncs.com/apps/anthropic
  Model id: qwen3.6-plus
  API key source:
    ● Paste key now        · stored plaintext in ~/.claude/claude-overnight/providers.json (0600)
    ○ Read from env var    · nothing written to disk
```

Saved providers live user-level at `~/.claude/claude-overnight/providers.json` (mode 0600) and show up automatically in every repo. No per-project config.

**How routing works.** Each `query()` gets its own env override (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) — planner queries use the planner provider, executor queries use the executor provider. No global shell env, no proxy daemon, no `process.env` pollution between calls.

**Pre-flight.** Before the swarm starts, each custom provider is pinged with a 1-turn auth check. Bad keys fail fast with `✗ executor preflight failed: ...` instead of N scattered mid-run errors.

**Resume.** Provider ids are persisted in `run.json` and rehydrated on resume. If you deleted a provider between runs, resume refuses to start and tells you exactly which id is missing.

**Non-interactive / CI.** `claude-overnight --model=qwen3.6-plus` auto-resolves the model id to a saved provider — no separate `--provider` flag.

## Spend caps and usage controls

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

When using extra usage with a budget, a dedicated progress bar shows spend vs limit with color-coded fill (magenta → yellow → red).

## Rate-limit handling and crash-safe recovery

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

## Git worktrees and branch merging

Each agent session gets an isolated git worktree (`swarm/task-N` branch). Changes auto-commit. After all sessions complete, branches merge back.

- `"yolo"` (default): merges into your current branch
- `"branch"`: creates a new `swarm/run-{timestamp}` branch

Conflicts retry with `-X theirs`. Unresolved branches are preserved for manual merge.

## Claude Code plugin

This repo also ships a Claude Code plugin so any Claude instance (inside this repo or any other) knows how to use, inspect, and resume `claude-overnight` runs:

```
/plugin marketplace add Fornace/claude-overnight
/plugin install claude-overnight
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tasks succeeded |
| `1` | Some tasks failed |
| `2` | All failed or none completed |

## License

MIT
