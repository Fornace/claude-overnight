# claude-overnight

Parallel Claude agents in isolated git worktrees. Set a usage cap so your interactive Claude Code keeps its headroom. Rate-limited? It waits. Crash? It resumes with full context.

Hand it an objective and a session budget, walk away, review the diff when the run ends. Every agent runs in its own worktree on its own branch — a misbehaving agent can't trash your working tree. Unmerged branches are preserved for manual review, never discarded.

Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Pair any planner (Opus, Sonnet) with any executor — Anthropic, Cursor, Qwen, OpenRouter, or any Anthropic-compatible endpoint.

## Run on Qwen 3.6 Plus

Hit your Claude Max plan limits? Running on a tight budget? Qwen 3.6 Plus via Alibaba Cloud's DashScope gateway is a drop-in executor that speaks the Anthropic Messages API  -- same client, same flow, pennies per run.

1. **Get an API key.** Sign up at [Alibaba Cloud](https://account.alibabacloud.com/login/login.htm?oauth_callback=https%3A%2F%2Fmodelstudio.console.alibabacloud.com%2Fap-southeast-1%3Ftab%3Ddashboard%23%2Fapi-key&clearRedirectCookie=1)  -- the link takes you straight to the API key dashboard.
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

## Run via Cursor API Proxy

Use Cursor's model gateway as an executor -- `auto` (delegates to best available), `composer`, or `composer-2` models. Runs locally through a proxy that speaks the Anthropic Messages API, so it's a drop-in replacement for any other provider.

### macOS: Cursor agent shell patch

On macOS, Cursor's `agent` / `cursor-agent` CLI often misbehaves because it uses a bundled Node.js. Add this to `~/.zshrc` so the `agent` command runs the real script with your **system** Node (then `source ~/.zshrc` or open a new terminal):

```bash
# Force Cursor Agent to use System Node.js
run_cursor_agent() {
    # Find the real directory of the cursor-agent script (resolves symlinks)
    local agent_path="$(command -v cursor-agent)"
    local script_dir="$(dirname "$(realpath "$agent_path")")"

    # Run the core JS file directly with your system node
    node "$script_dir/index.js" "$@"
}

# Overwrite any existing 'agent' alias to use our custom function
alias agent="run_cursor_agent"
```

`claude-overnight` prints a one-time notice when you use the Cursor proxy and this snippet is not detected in `~/.zshrc` or `~/.zprofile`. The bundled proxy also sets `CURSOR_AGENT_NODE` / `CURSOR_AGENT_SCRIPT` when it can find `node` and `cursor-agent`, but your interactive shell still benefits from the alias.

1. **Install the Cursor CLI and proxy:**

   ```bash
   curl https://cursor.com/install -fsS | bash
   npm install -g cursor-api-proxy
   ```

2. **Get an API key.** Visit [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) and scroll to the "API Keys" section.

3. **Set up.** Run `claude-overnight` and when prompted to pick a model, choose **Cursor…**. It walks you through a one-time setup: CLI check, API key entry (persisted to `providers.json`), and proxy health check.

4. **Start the proxy** (in a separate terminal):

   ```bash
   npx cursor-api-proxy
   ```

5. Pick your model (`auto`, `composer`, `composer-2`, etc.). The provider is saved and reappears in every future run.

Or configure the key manually:

```bash
export CURSOR_BRIDGE_API_KEY="sk-..."
npx cursor-api-proxy &
claude-overnight
```

**Tip:** run `claude-overnight` with the `--model=cursor-auto` flag in non-interactive mode to skip the picker. If the proxy isn't running at startup, a warning is shown but Anthropic providers remain available.

### macOS: “Keychain Not Found” / `cursor-user`

The Cursor **`agent`** binary stores an interactive login as **`cursor-user`** in your **login** keychain. For automation, use a **[User API key](https://cursor.com/docs/cli/headless)** (`export CURSOR_API_KEY=...` from [Integrations](https://cursor.com/dashboard/integrations)) — the bundled proxy then does not need Keychain. `claude-overnight` forces `CURSOR_SKIP_KEYCHAIN=1` and `CI=true`; if System Settings still shows **“A keychain cannot be found to store …”**, the login keychain is often missing or damaged: open **Keychain Access → First Aid** on **login**, or use **Reset To Defaults** in the dialog. Some users fix a stuck keychain with:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

**Automation:** Saving a key via **Cursor…** in `claude-overnight` is enough — it is written to `providers.json` and injected into both the Claude SDK env and the bundled proxy (including `CURSOR_API_KEY` for the native `agent`). You do not need to `export` variables unless you want to override for one shell.

**Advanced:** If something else must share port `8765` and you manage the proxy yourself, set `CURSOR_OVERNIGHT_NO_PROXY_RESTART=1` to skip the automatic “replace listener” step when a Cursor API token is present.

**How headless Cursor + macOS Keychain actually works (discovery):** We documented the full investigation: why ACP was the wrong path for opus/sonnet `*-thinking-*` variants (model-name mismatch → silent `exit 1`), how **chat-only workspace** (default in cursor-composer) fakes `HOME` and triggers **Keychain timeouts** despite a User API key, and how a cloned **account pool** makes parallel cursor-agent spawns race-free. See **[docs/CURSOR_PROXY_MACOS_DISCOVERY.md](docs/CURSOR_PROXY_MACOS_DISCOVERY.md)**.

**Quick reference — bundled proxy env:** `CURSOR_BRIDGE_USE_ACP=0` (CLI streaming path accepts all friendly model names), `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`, `CURSOR_CONFIG_DIRS=<5 cloned pool dirs>` (parallel-safe), plus `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` / `CURSOR_BRIDGE_API_KEY` and `CURSOR_SKIP_KEYCHAIN=1` / `CI=true`. Details and tables are in the doc above.

**Regression / stress test:** `npm run matrix:cursor-proxy` (optional `--quick`, `--include-danger`). Use `MATRIX_MODELS=composer-2,claude-opus-4-7-thinking-high` to compare models; override `MATRIX_PORT_BASE`, `MATRIX_MODEL`, `MATRIX_MSG_TIMEOUT_MS` as needed.

## Install

```bash
npm install -g claude-overnight
```

Requires Node.js ≥ 20 and Claude authentication (`claude auth login` or `ANTHROPIC_API_KEY`). No Anthropic plan or key? See **Run on Qwen 3.6 Plus** above  -- a cheap, drop-in alternative.

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

④ Planner model (thinking, steering  -- use your strongest):
  ● Opus  -- Opus 4.6 · Most capable
  ○ Sonnet  -- Sonnet 4.6 · Best for everyday tasks

⑤ Executor model (what runs the tasks  -- Qwen 3.6 Plus / OpenRouter / etc via Other…):
  ● Sonnet  -- Sonnet 4.6 · Best for everyday tasks
  ○ Opus  -- Opus 4.6 · Most capable
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

You interact once (objective, budget, model, review themes), then the rest runs unattended  -- thinking, planning, executing, reflecting, steering. Rate-limited? It waits and retries. Crash? Resume where you left off. Capped at usage limit? Pick up next time with full context preserved.

## Use cases

Overnight refactors, batch feature implementation, codebase-wide cleanups, test generation, documentation sprints, framework migrations, quality audits, long research runs. One objective + a budget + walk away.

## How it works

### 1. Thinking phase  -- parallel architect sessions

For budgets > 15, the tool launches **architect agents** that explore your codebase before any code is written. Each one gets a different research angle (architecture, data models, APIs, testing, etc.) and writes a structured design document. The number scales with budget: 5 for budget=50, 10 for budget=2000.

### 2. Task orchestration

An orchestrator session reads all design documents and synthesizes concrete execution tasks  -- grounded in real files and patterns the architects found. The task plan is also written to a file for resilience  -- if orchestration is interrupted, partial results survive.

### 3. Parallel execution waves

Tasks run in parallel agent sessions (each in its own git worktree). After completing its task, each session automatically runs a **simplify pass**  -- reviewing its own `git diff` for code reuse opportunities, quality issues, and inefficiencies, then fixing them before the framework commits. This is done via the SDK's **session resume** mechanism: the same agent session continues with a follow-up prompt, so the agent's full context from its task is still available  -- no need to re-instruct or re-fill context.

### 4. Post-wave review

After each wave (flex mode, budget remaining), a dedicated **review agent** inspects the consolidated diff for issues the individual agents may have blind-spotted: missed reuse opportunities, copy-paste variations, leaky abstractions, efficiency regressions. Runs as a single-agent wave  -- one session reviews what the swarm just produced.

### 5. Post-run final gate

When the run completes (steering declares done), a final **comprehensive review** runs against the full `git diff main`. Checks architecture coherence, consistency with existing patterns, build integrity, and test pass. The last quality gate before the diff lands.

### 6. Steering

After each wave, steering assesses: "how good is this?"  -- not "what's missing?" It can:

- **Execute** more tasks to build features, fix bugs, polish UX
- **Reflect** by spinning up 1-2 review sessions for deep quality/architecture audits
- **Declare done** when the vision is met at high quality

### Three-layer context memory

Long runs stay sharp because steering maintains three layers of memory:

- **Status**  -- a living project snapshot, updated every wave. Compressed, never truncated.
- **Milestones**  -- strategic snapshots archived every ~5 waves. Long-term memory.
- **Goal**  -- the evolving north star. What quality means for this codebase.

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

Any run that stops before the steering system declares the objective complete  -- capped at usage limit, Ctrl+C, crash, rate limit timeout, steering failure  -- is automatically resumable:

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

If the thinking phase succeeds but orchestration crashes, the next run detects the orphaned design docs and reuses them  -- no re-running $9 worth of architect sessions:

```
  ✓ Reusing 5 design docs (from prior attempt)
    Focus 0: Project Wizard UI vs VISION.md Flow
    Focus 1: Team Load and Rebalancer Surface
    Focus 2: Code Health After Swarm Wave
    ...
```

**Knowledge carries forward**  -- new runs inherit knowledge from completed previous runs. Thinking sessions and steering see what past runs built. Run 2 knows run 1 already built the auth system.

Add `.claude-overnight/` to your `.gitignore` (with the trailing slash  -- see below).

A separate, tiny `claude-overnight.log.md` is also written at the repo root on every run. It's human-readable, append-only, one block per run (objective, start/finish, cost, outcome, branch), and is designed to be **committed**  -- so even after `.claude-overnight/` is cleaned up you can still recover which prompt produced which commits. Use `.claude-overnight/` (with trailing slash) in your gitignore so this file isn't matched by accident.

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
| `--model=NAME` | prompted | Worker model  -- interactive picks planner + executor separately; `Other…` adds Qwen / OpenRouter / any Anthropic-compat endpoint. In non-interactive mode, a saved provider's model id is auto-resolved to the provider. |
| `--usage-cap=N` | unlimited | Stop at N% utilization |
| `--allow-extra-usage` | off | Allow extra/overage usage (billed separately) |
| `--extra-usage-budget=N` |  -- | Max $ for extra usage (implies --allow-extra-usage) |
| `--timeout=SECONDS` | `900` | Inactivity timeout per agent (nudges at timeout, kills at 2×) |
| `--no-flex` |  -- | Disable multi-wave steering |
| `--dry-run` |  -- | Show planned tasks without running |

## Task file fields

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run |
| `objective` | `string` |  -- | High-level goal for steering |
| `flexiblePlan` | `boolean` | `false` | Enable multi-wave planning |
| `model` | `string` | prompted | Worker model |
| `concurrency` | `number` | `5` | Parallel agents |
| `worktrees` | `boolean` | auto | Git worktree isolation |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | Permission handling |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or new branch |
| `usageCap` | `number (0-100)` | unlimited | Stop at N% utilization |

## Custom providers (Qwen, OpenRouter, any Anthropic-compatible endpoint)

Planner and executor are picked separately  -- pair Opus-on-Anthropic for the planner/thinker with a cheaper model on another provider for the bulk of execution.

From the interactive picker, choose `Other…` on the planner or executor step:

```
⑤ Executor model (what runs the tasks  -- Qwen 3.6 Plus / OpenRouter / etc via Other…):
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

**How routing works.** Each `query()` gets its own env override (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`)  -- planner queries use the planner provider, executor queries use the executor provider. No global shell env, no proxy daemon, no `process.env` pollution between calls.

**Pre-flight.** Before the swarm starts, each custom provider is pinged with a 1-turn auth check. Bad keys fail fast with `✗ executor preflight failed: ...` instead of N scattered mid-run errors.

**Resume.** Provider ids are persisted in `run.json` and rehydrated on resume. If you deleted a provider between runs, resume refuses to start and tells you exactly which id is missing.

**Non-interactive / CI.** `claude-overnight --model=qwen3.6-plus` auto-resolves the model id to a saved provider  -- no separate `--provider` flag.

## Parallel Playwright Testing

When agents use the Playwright MCP server for testing, parallel instances conflict on browser locks and cookie state. Add multiple MCP entries to `settings.json`:

```json
{
  "mcpServers": {
    "playwright-1": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest", "--isolated", "--headless"]
    },
    "playwright-2": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest", "--isolated", "--headless"]
    }
  }
}
```

**Isolation levels:**

| Goal | Approach |
|---|---|
| Non-disruptive, no focus steal | Headless mode (default) |
| Parallel agents, no shared cookies | Headless + `--isolated` per MCP server |
| Parallel agents, each with saved login | Headless + unique `userDataDir` or `--storage-state` per server |
| Anti-bot interception (CAPTCHA, Cloudflare) | Drop `--headless` only when necessary |

See `QUICKSHEET_PLAYWRIGHT.md` for full config examples.

## Spend caps and usage controls

### Extra usage protection

By default, extra/overage usage is **blocked**. When your plan's rate limits are exhausted, the run stops cleanly and is resumable. You control this in the interactive prompt (step ⑤) or via CLI flags:

- `--allow-extra-usage`  -- opt in to extra usage (billed separately)
- `--extra-usage-budget=20`  -- allow up to $20 of extra usage, then stop

### Live controls during execution

Press these keys while agents are running:

| Key | Action |
|---|---|
| `b` | Change remaining budget (number of sessions) |
| `t` | Change usage cap threshold (0-100%) |
| `q` | Graceful stop (press twice to force quit) |

Changes take effect between waves  -- active agents finish their current task.

### Multi-window usage display

The usage bar cycles through all rate limit windows (5h, 7d, etc.) every 3 seconds, showing utilization per window. Usage info is shown during all phases  -- thinking, orchestration, steering, and execution.

When using extra usage with a budget, a dedicated progress bar shows spend vs limit with color-coded fill (magenta → yellow → red).

## Rate-limit handling and crash-safe recovery

Built for unattended runs lasting hours or days.

- **Smooth overage transition**: when extra usage is allowed, plan limit rejection is seamless  -- no dispatch blocking, agents continue into overage
- **Interrupt + resume**: agents and planner queries that go silent are interrupted and resumed with full conversation context via SDK session resume  -- not killed and restarted from scratch
- **Hard block**: pauses until the rate limit window resets, then resumes
- **Soft throttle**: slows dispatch at >75% utilization
- **Extra usage guard**: detects overage billing and stops unless explicitly allowed
- **Cooldown between phases**: waits for rate limit reset after thinking before starting orchestration
- **Retry with backoff**: transient errors (429, overloaded) retry automatically
- **Usage cap**: set a ceiling, active agents finish, no new ones start  -- run is resumable
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
