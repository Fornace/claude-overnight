# claude-overnight

Overnight coding swarms in isolated git worktrees that plan, execute, review, and steer themselves until the objective is met. Hand it a goal and a budget, walk away, review the diff in the morning.

Every agent runs in its own worktree on its own branch, so a misbehaving session cannot trash your working tree. Unmerged branches are preserved for manual review, never discarded. Set a usage cap (say 90%) and your interactive Claude Code still has headroom to answer questions while the swarm runs.

Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk): every planner, worker, reviewer, and verifier session runs on the SDK's agent harness with full session resume, streaming, and transcripts. `claude-overnight` is the orchestrator around that harness. It plans, routes, curates, resumes, and persists many SDK sessions at once. Because the harness speaks the Anthropic Messages API, any compatible endpoint plugs in as a role.

## Three execution layers, mix per run

| Layer | Runs on | What it does |
|---|---|---|
| Planner (harness) | Opus 4.6, Sonnet 4.6 | Thinking wave, orchestration, steering, post-wave review, final gate |
| Main worker | Sonnet, Gemini 2.5, Qwen 3.6 Plus, DeepSeek, any Anthropic-compatible endpoint | Bulk implementation |
| Fast worker (optional) | Kimi 2.6 Coding, Cursor composer-2, Haiku | Cheap well-scoped tasks, double-checked by later waves |

A common recipe: **Opus planner + Sonnet bulk worker + Cursor composer-2 fast worker**. Another: **Opus planner + Kimi 2.6 bulk worker + Haiku fast worker**. Providers are saved once to `~/.claude/claude-overnight/providers.json` and appear in every future run. The bundled `cursor-composer-in-claude` proxy makes Cursor-hosted models (`auto`, `composer`, `composer-2`) look like a normal provider.

## What this recipe does that others do not

**Self-curating skill memory that improves mid-run.** Workers emit memory candidates when they discover something reusable: a repo-specific quirk, a recovery path, a command sequence that worked, a tool recipe worth saving. A scribe appends each candidate to disk without blocking the run. At the end of every wave, a **librarian** pass curates the queue. It promotes candidates into canon, patches existing skills via diff-style edits, or quarantines stale ones. **Wave N+1 of the same run starts with a better skill library than wave N.** Across runs, the library compounds. Inspired by Nous Research's Hermes Agent (Feb 2026), with progressive disclosure (L0 stub in every prompt, L1 body loaded on demand, L2 references on request), SQLite FTS5 retrieval, and per-skill win-rate tracking that auto-quarantines rot.

**Self-fixing, not just self-running.** Every task agent reviews its own `git diff` via SDK session resume (same session, full task context, no re-prompting) and runs a simplify pass before the commit lands. After each wave a dedicated review agent scans the consolidated diff for cross-agent issues the individual sessions could not see: missed reuse, copy-paste variations, leaky abstractions. When steering declares the objective done, a final gate reviews the full `git diff main` for architecture coherence before anything reaches your working tree.

**Multi-wave autonomous loop, not fire-and-forget.** After each wave a steering pass asks "how good is this?" and chooses between executing more tasks, spinning up a deeper reflection wave, or declaring done. The loop keeps going until steering is satisfied, the budget is exhausted, or the usage cap trips. Long runs keep a living status snapshot, archived milestones every five waves, and an evolving goal file, so steering picks up exactly where it left off after a rate limit or an overnight stop.

**Headroom-aware usage cap.** Set the cap to 90% of your 5h window and the swarm stops accepting new work there. Your interactive Claude Code keeps the remaining 10% to answer questions or run its own sessions while the overnight run grinds on.

**Crash-safe by design.** Planner state, the task plan, design docs, per-query NDJSON transcripts, steering decisions, and wave milestones all land on disk as they are produced. If the process dies mid-plan, the next resume salvages `tasks.json` and skips the expensive thinking wave. Planner crashes do not lose the $2 to $4 of orchestration work that already happened.

## Run on Kimi 2.6

Want a cheap Anthropic-compatible worker with a simple shell setup? Kimi 2.6 via Kimi's coding endpoint is a drop-in worker that speaks the Anthropic Messages API, same client, same flow, just a different base URL.

1. **Configure the provider.** Run `claude-overnight`, choose `Other…` on the worker step, and fill in:

   | Field | Value |
   |---|---|
   | Name | `Kimi 2.6` |
   | Base URL | `https://api.kimi.com/coding/` |
   | Model id | `kimi-for-coding` |
   | API key | your Kimi coding key |

2. That's it. Planner runs on Sonnet (or Opus), worker runs on Kimi.

Or set it via env directly:

```bash
export ANTHROPIC_BASE_URL="https://api.kimi.com/coding/"
export ANTHROPIC_API_KEY="sk-kimi-..."
export ANTHROPIC_MODEL="kimi-for-coding"
claude-overnight
```

## Run on Qwen 3.6 Plus

Hit your Claude Max plan limits? Running on a tight budget? Qwen 3.6 Plus via Alibaba Cloud's DashScope gateway is a drop-in worker that speaks the Anthropic Messages API, same client, same flow, pennies per run.

1. **Get an API key.** Sign up at [Alibaba Cloud](https://account.alibabacloud.com/login/login.htm?oauth_callback=https%3A%2F%2Fmodelstudio.console.alibabacloud.com%2Fap-southeast-1%3Ftab%3Ddashboard%23%2Fapi-key&clearRedirectCookie=1), the link takes you straight to the API key dashboard.
2. **Configure the provider.** Run `claude-overnight`, choose `Other…` on the worker step, and fill in:

   | Field | Value |
   |---|---|
   | Name | `Qwen 3.6 Plus` |
   | Base URL | `https://dashscope-intl.aliyuncs.com/apps/anthropic` |
   | Model id | `qwen3.6-plus` |
   | API key | your DashScope key |

3. That's it. Planner runs on Sonnet (or Opus), worker runs on Qwen.

Or set it via env directly:

```bash
export ANTHROPIC_BASE_URL="https://dashscope-intl.aliyuncs.com/apps/anthropic"
export ANTHROPIC_API_KEY="sk-..."
export ANTHROPIC_MODEL="qwen3.6-plus"
claude-overnight
```

## Run via Bundled Cursor Proxy

Use Cursor-hosted models (`auto`, `composer`, `composer-2`, etc.) through the bundled `cursor-composer-in-claude` proxy. `claude-overnight` auto-starts that local Anthropic-compatible proxy, injects the per-worktree workspace header, and treats Cursor as just another provider for the planner, main worker, or fast worker.

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

1. **Install the Cursor CLI:**

   ```bash
   curl https://cursor.com/install -fsS | bash
   ```

2. **Get an API key.** Visit [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) and scroll to the "API Keys" section.

3. **Set up.** Run `claude-overnight` and when prompted to pick a model, choose **Cursor…**. It walks you through a one-time setup: CLI check, API key entry (persisted to `providers.json`), bundled proxy verification, and health check.

4. Pick your model (`auto`, `composer`, `composer-2`, etc.). The provider is saved and reappears in every future run.

Or configure the key manually:

```bash
export CURSOR_BRIDGE_API_KEY="crsr_..."
claude-overnight
```

If the bundled proxy cannot auto-start, the setup wizard prints the exact `node ".../cursor-composer-in-claude/dist/cli.js"` command for this install so you can launch the same embedded proxy manually.

**Tip:** once a Cursor provider is saved, run `claude-overnight` with the `--model=cursor-auto` flag in non-interactive mode to skip the picker. If the proxy isn't running at startup, the tool attempts to restart it automatically.

### macOS: “Keychain Not Found” / `cursor-user`

The Cursor **`agent`** binary stores an interactive login as **`cursor-user`** in your **login** keychain. For automation, use a **[User API key](https://cursor.com/docs/cli/headless)** (`export CURSOR_API_KEY=...` from [Integrations](https://cursor.com/dashboard/integrations)): the bundled proxy then does not need Keychain. `claude-overnight` forces `CURSOR_SKIP_KEYCHAIN=1` and `CI=true`; if System Settings still shows **“A keychain cannot be found to store …”**, the login keychain is often missing or damaged: open **Keychain Access → First Aid** on **login**, or use **Reset To Defaults** in the dialog. Some users fix a stuck keychain with:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

**Automation:** Saving a key via **Cursor…** in `claude-overnight` is enough. It is written to `providers.json` and injected into both the Claude SDK env and the bundled proxy (including `CURSOR_API_KEY` for the native `agent`). You do not need to `export` variables unless you want to override for one shell.

**Advanced:** If something else must share port `8765` and you manage the proxy yourself, set `CURSOR_OVERNIGHT_NO_PROXY_RESTART=1` to skip the automatic “replace listener” step when a Cursor API token is present.

**How headless Cursor + macOS Keychain actually works (discovery):** We documented the full investigation: why ACP was the wrong path for opus/sonnet `*-thinking-*` variants (model-name mismatch → silent `exit 1`), how **chat-only workspace** (default in cursor-composer) fakes `HOME` and triggers **Keychain timeouts** despite a User API key, and how a cloned **account pool** makes parallel cursor-agent spawns race-free. See **[docs/CURSOR_PROXY_MACOS_DISCOVERY.md](docs/CURSOR_PROXY_MACOS_DISCOVERY.md)**.

**Quick reference, bundled proxy env:** `CURSOR_BRIDGE_USE_ACP=0` (CLI streaming path accepts all friendly model names), `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`, `CURSOR_CONFIG_DIRS=<5 cloned pool dirs>` (parallel-safe), plus `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` / `CURSOR_BRIDGE_API_KEY` and `CURSOR_SKIP_KEYCHAIN=1` / `CI=true`. Details and tables are in the doc above.

**Regression / stress test:** `npm run matrix:cursor-proxy` (optional `--quick`, `--include-danger`). Use `MATRIX_MODELS=composer-2,claude-opus-4-7-thinking-high` to compare models; override `MATRIX_PORT_BASE`, `MATRIX_MODEL`, `MATRIX_MSG_TIMEOUT_MS` as needed.

## Install

```bash
npm install -g claude-overnight
```

Requires Node.js ≥ 20. For Anthropic-direct roles, use `claude auth login` or `ANTHROPIC_API_KEY`. For provider-backed roles, save a Kimi / Qwen / Cursor / OpenRouter-compatible provider instead. No Anthropic plan or key? See **Run on Kimi 2.6** or **Run on Qwen 3.6 Plus** above for cheap drop-in alternatives.

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

④ Planner model (thinking, steering; use your strongest):
  ● Opus · Opus 4.6 · Most capable
  ○ Sonnet · Sonnet 4.6 · Best for everyday tasks

⑤ Worker model (runs the tasks; Kimi 2.6 / Qwen 3.6 Plus / OpenRouter / etc via Other…):
  ● Sonnet · Sonnet 4.6 · Best for everyday tasks
  ○ Opus · Opus 4.6 · Most capable
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

You interact once (objective, budget, model, review themes), then the rest runs unattended, thinking, planning, executing, curating memory, reflecting, steering. Rate-limited? It waits and retries. Crash? Resume where you left off. Capped at usage limit? Pick up next time with full context preserved.

## Use cases

Overnight refactors, batch feature implementation, codebase-wide cleanups, test generation, documentation sprints, framework migrations, quality audits, long research runs. One objective + a budget + walk away.

## Typical flow

```
┌─ Setup + planning ──────────────────────────────────────────────┐
│  start/resume  →  coach rewrites objective  →  pick planner,    │
│  worker, fast worker  →  provider preflight  →  theme review    │
│  →  thinking wave (parallel architects)  →  task orchestration  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌─ Wave loop ──────────▼──────────────────────────────────────────┐
│  beforeWave hook  →  execution wave (workers in worktrees)      │
│  →  per-agent simplify pass (session resume on same context)    │
│  →  debrief + afterWave hook  →  post-wave review agent         │
│  →  librarian curates skill candidates into canon               │
│  →  steering decides: execute more │ reflect deeper │ done      │
│         ↑                                                       │
│         └── loop until done, budget out, or cap hit             │
│  →  final gate reviews full `git diff main`                     │
└─────────────────────────────────────────────────────────────────┘

┌─ Skill memory (compounds within a run and across runs) ─────────┐
│  workers emit candidates  →  scribe writes to disk              │
│  →  librarian curates at wave end  →  canon markdown +          │
│  SQLite FTS5 index updated  →  next wave gets an L0 stub,       │
│  hydrates L1 body on demand, L2 references on request           │
└─────────────────────────────────────────────────────────────────┘
```

This is the main user-visible lifecycle. Engine-internal branches (health-check heal tasks, A/B skill assignment across sibling branches, zero-work retry, budget-extension prompts, resume salvage after planning crashes) are omitted for clarity.

### 1. Thinking phase: parallel architect sessions

For budgets > 15, the tool launches **architect agents** that explore your codebase before any code is written. Each one gets a different research angle (architecture, data models, APIs, testing, etc.) and writes a structured design document. The number scales with budget: 5 for budget=50, 10 for budget=2000.

### 2. Task orchestration

An orchestrator session reads all design documents and synthesizes concrete execution tasks, grounded in real files and patterns the architects found. The task plan is also written to a file for resilience: if orchestration is interrupted, partial results survive.

### 3. Parallel execution waves

Tasks run in parallel agent sessions (each in its own git worktree). After completing its task, each session automatically runs a **simplify pass**, reviewing its own `git diff` for code reuse opportunities, quality issues, and inefficiencies, then fixing them before the framework commits. This is done via the SDK's **session resume** mechanism: the same agent session continues with a follow-up prompt, so the agent's full context from its task is still available, no need to re-instruct or re-fill context. If a fast worker is configured, steering can route cheaper, well-scoped tasks there while the main worker handles heavier implementation.

### 4. Post-wave review

After each wave (flex mode, budget remaining), a dedicated **review agent** inspects the consolidated diff for issues the individual agents may have blind-spotted: missed reuse opportunities, copy-paste variations, leaky abstractions, efficiency regressions. Runs as a single-agent wave, one session reviews what the swarm just produced.

### 5. Librarian and dynamic memory

During execution, workers can emit **memory candidates** when they discover something reusable: a repo-specific quirk, a recovery path, a command sequence that worked, or a tool recipe worth reusing later. The scribe writes those candidates to `~/.claude-overnight/skills/<repo-fingerprint>/candidates/` without blocking the run.

At the end of each wave, a **librarian** pass curates that queue. It can promote a candidate into canon, patch an existing skill, quarantine stale skills, or reject weak / duplicated candidates. Canon lives on disk as markdown; SQLite is only the ranked index. This is what makes the memory system dynamic rather than a fixed prompt blob.

### 6. Steering

After each wave, steering asks "how good is this?" rather than "what's missing?". It can:

- **Execute** more tasks to build features, fix bugs, polish UX
- **Reflect** by spinning up 1-2 review sessions for deep quality/architecture audits
- **Declare done** when the vision is met at high quality

### 7. Post-run final gate

When the run completes (steering declares done), a final **comprehensive review** runs against the full `git diff main`. Checks architecture coherence, consistency with existing patterns, build integrity, and test pass. The last quality gate before the diff lands.

### Run-memory layers

Long runs stay sharp because steering maintains three run-memory layers:

- **Status**: a living project snapshot, updated every wave. Compressed, never truncated.
- **Milestones**: strategic snapshots archived every ~5 waves. Long-term memory.
- **Goal**: the evolving north star. What quality means for this codebase.

### Progressive-disclosure repo memory

The repo memory system is separate from the run folder and is designed around three disclosure layers so context stays small:

- **L0**: a tiny ranked stub injected into planner and worker prompts. It lists only the names and descriptions of the most relevant project-specific skills and tool recipes.
- **L1**: the full skill body, loaded on demand with `skill_read(name)` when an agent wants the actual recipe or guidance.
- **L2**: attached references for deeper context. The library is structured for them even though most runs only need the L0 stub plus occasional L1 hydration.

That progressive disclosure matters: the planner and workers do not carry the full memory library in every prompt. They get a compact overview, call `skill_search(query)` if they need to narrow it, and hydrate only the bodies that matter for the task in front of them.

## Run history, resume, and knowledge carryforward

Every run gets its own folder in `.claude-overnight/runs/`. Nothing is ever overwritten.

```
.claude-overnight/
  runs/
    2026-04-04T18-52-49/     ← run A (done, $200, 200 tasks)
      run.json          ← full resume state (models, budget, wave history)
      status.md, goal.md, themes.md
      designs/          ← per-focus research docs from the thinking wave
      tasks.json        ← the plan the swarm is executing
      transcripts/      ← NDJSON per planner query: themes, orchestrate, steer-wave-N, ...
      steering/         ← steering decisions per wave
      milestones/, sessions/
    2026-04-05T10-30-00/     ← run B (crashed mid-planning)
      run.json, transcripts/themes.ndjson   ← see exactly what the planner was doing
```

Any run that stops before the steering system declares the objective complete, capped at usage limit, Ctrl+C, crash, rate limit timeout, steering failure, is automatically resumable:

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

If the thinking phase succeeds but orchestration crashes, the next run detects the orphaned design docs and reuses them, no re-running $9 worth of architect sessions:

```
  ✓ Reusing 5 design docs (from prior attempt)
    Focus 0: Project Wizard UI vs VISION.md Flow
    Focus 1: Team Load and Rebalancer Surface
    Focus 2: Code Health After Swarm Wave
    ...
```

**Knowledge carries forward**, new runs inherit knowledge from completed previous runs. Thinking sessions and steering see what past runs built. Run 2 knows run 1 already built the auth system.

### Transcripts and streaming

Every planner/steering query streams through the Agent SDK with `includePartialMessages: true`, so tool calls, thinking, and text deltas are captured as they happen. Each query also appends an NDJSON transcript under `runs/<ts>/transcripts/<name>.ndjson`, so if the planner crashes mid-think you still have the forensic trail (prompt preview, every tool use, every text/thinking delta, rate-limit events, and the final result or error). `themes.md` is also written as a human-readable summary right after the thinking wave.

Not every provider delivers the same streaming granularity:

| Provider | Tool-use events | Thinking deltas | Text deltas |
| --- | --- | --- | --- |
| Anthropic (direct) | ✓ | ✓ | ✓ |
| Cursor proxy (`cursor-composer-in-claude`) | no | no | ✓ (final answer only) |
| Kimi / Qwen / OpenRouter / custom Anthropic-compatible | depends on upstream | depends | usually ✓ |

When a provider doesn't stream partials (or the model is a reasoning model on the Cursor proxy, where the proxy suppresses the thinking phase and only emits the final answer), the ticker shows elapsed time with no live text, then the completed result lands in one go. The UI, transcripts, and the resume flow all behave identically either way: streaming is used when available, never required.

Add `.claude-overnight/` to your `.gitignore` (with the trailing slash, see below).

A separate, tiny `claude-overnight.log.md` is also written at the repo root on every run. It's human-readable, append-only, one block per run (objective, start/finish, cost, outcome, branch), and is designed to be **committed**, so even after `.claude-overnight/` is cleaned up you can still recover which prompt produced which commits. Use `.claude-overnight/` (with trailing slash) in your gitignore so this file isn't matched by accident.

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
| `--model=NAME` | prompted | Worker model. Interactive picks planner and worker separately; `Other…` adds Kimi / Qwen / OpenRouter / any Anthropic-compat endpoint. In non-interactive mode, a saved provider's model id is auto-resolved to the provider. |
| `--usage-cap=N` | unlimited | Stop at N% utilization |
| `--allow-extra-usage` | off | Allow extra/overage usage (billed separately) |
| `--extra-usage-budget=N` |      | Max $ for extra usage (implies --allow-extra-usage) |
| `--timeout=SECONDS` | `900` | Inactivity timeout per agent (nudges at timeout, kills at 2×) |
| `--no-flex` |      | Disable multi-wave steering |
| `--dry-run` |      | Show planned tasks without running |

## Task file fields

| Field | Type | Default | Description |
|---|---|---|---|
| `tasks` | `(string \| {prompt, cwd?, model?})[]` | required | Tasks to run |
| `objective` | `string` |      | High-level goal for steering |
| `flexiblePlan` | `boolean` | `false` | Enable multi-wave planning |
| `model` | `string` | prompted | Worker model |
| `concurrency` | `number` | `5` | Parallel agents |
| `worktrees` | `boolean` | auto | Git worktree isolation |
| `permissionMode` | `"auto" \| "bypassPermissions" \| "default"` | `"auto"` | Permission handling |
| `mergeStrategy` | `"yolo" \| "branch"` | `"yolo"` | Merge into HEAD or new branch |
| `usageCap` | `number (0-100)` | unlimited | Stop at N% utilization |

## Custom providers (Kimi, Qwen, OpenRouter, any Anthropic-compatible endpoint)

Planner, main worker, and optional fast worker are each picked separately. Pair Opus-on-Anthropic for the planner/thinker with a cheaper model on another provider for the bulk of work. The fast worker is a real worker (same tools, same env), just on a cheaper/faster model, and steering routes well-scoped tasks to it by default.

From the interactive picker, choose `Other…` on the planner, worker, or fast step:

```
⑤ Worker model (runs the tasks; Kimi 2.6 / Qwen 3.6 Plus / OpenRouter / etc via Other…):
  ○ Sonnet
  ○ Opus
  ● Other…

  Name: Kimi 2.6
  Base URL: https://api.kimi.com/coding/
  Model id: kimi-for-coding
  API key source:
    ● Paste key now        · stored plaintext in ~/.claude/claude-overnight/providers.json (0600)
    ○ Read from env var    · nothing written to disk
```

Common examples:

| Name | Base URL | Model id |
|---|---|---|
| `Kimi 2.6` | `https://api.kimi.com/coding/` | `kimi-for-coding` |
| `Qwen 3.6 Plus` | `https://dashscope-intl.aliyuncs.com/apps/anthropic` | `qwen3.6-plus` |

Saved providers live user-level at `~/.claude/claude-overnight/providers.json` (mode 0600) and show up automatically in every repo. No per-project config.

**How routing works.** Each `query()` gets its own env override (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), planner queries use the planner provider, main-worker queries use the worker provider, fast-worker queries use the fast provider. No global shell env, no proxy daemon, no `process.env` pollution between calls.

**Pre-flight.** Before the swarm starts, each custom provider is pinged with a 1-turn auth check. Bad keys fail fast with `✗ worker preflight failed: ...` instead of N scattered mid-run errors.

**Resume.** Provider ids are persisted in `run.json` and rehydrated on resume. If you deleted a provider between runs, resume refuses to start and tells you exactly which id is missing.

**Non-interactive / CI.** `claude-overnight --model=kimi-for-coding` (or `qwen3.6-plus`) auto-resolves the model id to a saved provider, no separate `--provider` flag.

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

- `--allow-extra-usage`, opt in to extra usage (billed separately)
- `--extra-usage-budget=20`, allow up to $20 of extra usage, then stop

### Live controls during execution

Press these keys while agents are running:

| Key | Action |
|---|---|
| `b` | Change remaining budget (number of sessions) |
| `t` | Change usage cap threshold (0-100%) |
| `q` | Graceful stop (press twice to force quit) |

Changes take effect between waves; active agents finish their current task.

### Multi-window usage display

The usage bar cycles through all rate limit windows (5h, 7d, etc.) every 3 seconds, showing utilization per window. Usage info is shown during all phases: thinking, orchestration, steering, and execution.

When using extra usage with a budget, a dedicated progress bar shows spend vs limit with color-coded fill (magenta → yellow → red).

## Rate-limit handling and crash-safe recovery

Built for unattended runs lasting hours or days.

- **Smooth overage transition**: when extra usage is allowed, plan limit rejection is seamless, no dispatch blocking, agents continue into overage
- **Interrupt + resume**: agents and planner queries that go silent are interrupted and resumed with full conversation context via SDK session resume, not killed and restarted from scratch
- **Hard block**: pauses until the rate limit window resets, then resumes
- **Soft throttle**: slows dispatch at >75% utilization
- **Extra usage guard**: detects overage billing and stops unless explicitly allowed
- **Cooldown between phases**: waits for rate limit reset after thinking before starting orchestration
- **Retry with backoff**: transient errors (429, overloaded) retry automatically
- **Usage cap**: set a ceiling, active agents finish, no new ones start, run is resumable
- **Planner retries**: steering and orchestration retry on rate limits (30s/60s/120s backoff) with full context

## Git worktrees and branch merging

Each agent session gets an isolated git worktree (`swarm/task-N` branch). Changes auto-commit. After all sessions complete, branches merge back.

- `"yolo"` (default): merges into your current branch
- `"branch"`: creates a new `swarm/run-{timestamp}` branch

Conflicts retry with `-X theirs`. Unresolved branches are preserved for manual merge.

## Claude Code plugin

This repo ships a Claude Code plugin so any Claude instance (inside this repo or any other) knows how to use, inspect, and resume `claude-overnight` runs:

```
/plugin marketplace add Fornace/claude-overnight
/plugin install claude-overnight
```

The plugin includes a skill for **authoring runs outside the CLI**. Claude can help you pick the run shape, critique the budget and decomposition, and write a `tasks.json` file before you ever invoke the CLI.

### Writing `tasks.json` externally

When you pass a pre-written `tasks.json` to the CLI, it **skips the thinking wave and planning phase** and starts executing immediately:

```bash
claude-overnight tasks.json
```

This is useful when:
- You already have a concrete task list and don't need the planner to explore the codebase.
- You want to save the planner cost ($2–4) on a straightforward, mechanical job.
- You used the Claude skill to design the run and want to lock the plan before executing.

A fixed-plan `tasks.json` (without `flexiblePlan: true`) bypasses orchestration entirely. A flex-plan `tasks.json` (with `objective` + `flexiblePlan: true` + seed tasks) still uses steering across waves, but skips the initial thinking wave if the tasks are already concrete.

### What happens when `tasks.json` exists

- **Crash resilience.** During normal planning, the orchestrator writes `tasks.json` to disk as soon as it generates the tasks. If the planner crashes or the process dies before the run state is persisted, the next resume salvages the tasks from `tasks.json` instead of re-running the expensive planning query.
- **Resume fallback.** If a run's state file is missing or incomplete, the resume flow falls back to `tasks.json` to reconstruct the task list. This also covers legacy runs from before v1.11.7 where the agent wrote the file but the orchestrator didn't save `run.json`.
- **Orphan recovery.** The state scanner backfills minimal run metadata for any run directory that contains a `tasks.json` but no `run.json`, so incomplete planning shells still show up in `claude-overnight --list`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tasks succeeded |
| `1` | Some tasks failed |
| `2` | All failed or none completed |

## Prompt evolution (server-side)

The `src/prompt-evolution/` engine and `claude-overnight-evolve` CLI power a self-evolution pipeline that optimises prompts (the planner prompt here, MCP-browser's supervisor prompts, or any prompt in a user's repo) via Pareto-frontier mutation with LLM-as-judge and heuristic scoring.

**Multi-hour runs aren't meant for your laptop.** Three ways to run it:

1. **`npx claude-overnight-evolve …`** — quickest. Fine for smoke tests or short runs; needs `ANTHROPIC_API_KEY` in env and keeps running only as long as your shell is open. Output: `~/.claude-overnight/prompt-evolution/<runId>/`.
2. **Self-hosted Docker** — [`self-host/`](self-host/README.md) ships a tiny runner image + optional HTTP server (enqueue + read-back) you can run on any VPS. Laptop can be off.
3. **Fornace hosted** — already have a fornace project? `POST /api/projects/:id/prompt-evolution/enqueue` runs the same engine in your project's container. Body: `{ prompt, target, evalModel, generations, population, env?, anthropicApiKey?, anthropicBaseUrl?, anthropicModel? }`. Poll `GET /:runId` for status + inline `report.md`. See the [fornace integration doc § 2.6](https://github.com/Fornace/MCP-Browser/blob/main/docs/integration.md#26-prompt-evolution--apiprojectsidprompt-evolution).

Experiment credentials — any Anthropic-compatible provider (Anthropic direct, OpenRouter, Kimi, DashScope, a local proxy) — are injected via env vars: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `EVAL_MODEL`, `MUTATE_MODEL`. Self-host reads them from `self-host/.env` (or per-run `env:` in the enqueue body).

Full design: [docs/prompt-evolution-research.md](docs/prompt-evolution-research.md).

## License

MIT
