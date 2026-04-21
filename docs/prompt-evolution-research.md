# Prompt Evolution Research — Hermes-Agent Technical Analysis

> Date: 2026-04-21
> Status: Deployed
> Related: `src/prompt-evolution/`, `scripts/evolve-prompt.mjs`, MCP-browser `platform/api/prompt-evolution.routes.ts`

## What Hermes Agent Does

Hermes Agent (NousResearch) has **two complementary systems** for iterative prompt improvement:

### 1. Autoresearch Skill — Git-Based Experiment Loop
- **Branch → Experiment → Evaluate → Merge/Revert**
- Runs autonomously via cron in the background
- Two evaluation modes:
  - **ML/Code**: real metrics (accuracy, loss, latency)
  - **Knowledge**: self-evaluation rubric (5 criteria × 1–5 scale)
    - evidence, accuracy, depth, relevance, net_improvement
- Uses atomic JSON I/O for state, git for safety, watchdog for stall detection
- **Key insight**: main always holds the best version; experiments are disposable branches

### 2. Self-Evolution Repo — DSPy + GEPA
- Standalone optimization pipeline using **DSPy + GEPA** (Genetic-Pareto Prompt Evolution)
- ICLR 2026 Oral — reads execution traces to understand *why* things fail
- **Cost**: ~$2–10 per optimization run (no GPU training, pure API calls)
- **Loop**:
  1. Select target (skill, prompt, tool description)
  2. Build evaluation dataset (mine session_db or synthetic generation)
  3. Wrap as DSPy module
  4. Run GEPA optimizer (reflective evolution) or MIPROv2 (Bayesian fallback)
  5. Evaluate on held-out test set
  6. Deploy via PR with metrics, diffs, comparison
- **Scoring**: LLM-as-judge with rubrics:
  - Did the agent follow the skill's procedure? (0–1)
  - Was the output correct/useful? (0–1)
  - Was it concise (within token budget)? (0–1)
- **CLI**: `hermes evolve skill <name> --iterations 10`

## How We Adapted It

We took the architectural patterns from Hermes and built a lighter, zero-dependency-prompt-evolution system that fits inside `claude-overnight` and deploys on the MCP-browser platform.

### What We Built

| Component | Hermes Equivalent | Our Approach |
|-----------|------------------|--------------|
| **Experiment loop** | autoresearch git branches | In-memory generations with persistence to `~/.claude-overnight/prompt-evolution/<runId>/` |
| **Scoring** | LLM-as-judge rubrics | Multi-objective heuristic scoring (parse, schema, content, cost, speed) + optional LLM-judge module |
| **Mutation** | GEPA reflective evolution | Direct LLM call with failure traces + learning log + sibling crossover |
| **Curation** | Pareto frontier + merge/revert | Pareto-frontier selection with novelty bonus (elites + diversity) |
| **Deployment** | PR against hermes-agent repo | MCP-browser API route (`POST /api/projects/:id/prompt-evolution/enqueue`) |
| **Reporting** | Markdown report with token usage | `report.md` per run with diff, matrix, recommendations |

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MCP-browser Platform                                        │
│  POST /api/projects/:id/prompt-evolution/enqueue            │
│  GET  /api/projects/:id/prompt-evolution/:runId             │
│       └── spawns: node scripts/evolve-prompt.mjs            │
└──────────────────────────┬──────────────────────────────────┘
                           │ subprocess + env vars
┌──────────────────────────▼──────────────────────────────────┐
│  claude-overnight prompt-evolution engine                    │
│                                                              │
│  1. Seed population (TIGHT, STANDARD, LARGE variants)       │
│  2. Evaluate all variants × all cases → matrix              │
│  3. Curate: Pareto elites + diversity keep                  │
│  4. Mutate: LLM revises worst performers using failures     │
│  5. Repeat for N generations                                │
│  6. Generate report.md + persist to disk                    │
└─────────────────────────────────────────────────────────────┘
```

### File Layout (Organized & Inspectable)

```
~/.claude-overnight/prompt-evolution/<runId>/
  meta.json        — run config, timestamps, status
  matrix.jsonl     — one line per variant per generation
  learning.jsonl   — mutation history with fitness deltas
  best.md          — best variant prompt + metrics
  report.md        — full markdown report (diff, recommendations)
  prompts/
    default.md
    tight.md
    evo_xxxx.md    — every variant tested, preserved
```

### Scoring System

**Heuristic scorer** (`src/prompt-evolution/scorer.ts`) — fast, deterministic, no extra LLM calls:
- `parse` (0–1): valid JSON when expected
- `schema` (0–1): required fields present
- `content` (0–1): task count, independence, specificity
- `costEfficiency` (0–1): 1 / (1 + costUsd × 100)
- `speed` (0–1): 1 / (1 + durationMs / 10_000)

**LLM-as-judge** (`src/prompt-evolution/llm-judge.ts`) — for fuzzy criteria:
- 5-point Likert rubric: parse, schema, content, concision, instruction
- Normalised to 0–1, returns justification string
- Cost: ~$0.002–0.01 per case

**Aggregation**:
- Geometric mean across dimensions (rewards balanced performance, prevents overfitting)
- Pareto dominance for curation (keeps diversity)

### Who Generates the Prompt Matrices?

The **mutator** (`src/prompt-evolution/mutator.ts`) generates new prompt variants:
- Input: current prompt + failure traces + learning log + sibling variants
- Output: revised prompt inside markdown fence + one-line summary
- Uses the same API endpoint as evaluation (Anthropic-compatible)

### Who Scores Them?

The **evaluator** (`src/prompt-evolution/evaluator.ts`) scores them:
- Runs each variant against every benchmark case
- Calls the model API directly (fast/cheap model like haiku/flash)
- Uses the heuristic scorer for instant feedback
- Optional LLM-judge for final validation gate

### Mutation Prompt (Engineering Detail)

The mutator system prompt is carefully constrained:
- "Keep the same general purpose and structure"
- "Be surgical: change only what's needed to fix the failures"
- "Do NOT retry approaches listed in the LEARNING LOG that previously regressed"
- "If a sibling prompt handles a failure case well, borrow its technique (crossover)"

This is the exact pattern Hermes uses in GEPA — reflective evolution that learns from execution traces rather than blind mutation.

## Deployment on MCP-browser Platform

We added a new first-class API route to MCP-browser:

```bash
# Enqueue an evolution run
POST /api/projects/:id/prompt-evolution/enqueue
{
  "target": "mcp-browser",
  "prompt": "plan-supervision",
  "evalModel": "claude-haiku-4-5",
  "generations": 10,
  "population": 8,
  "plateau": 3
}

# Check status and retrieve report
GET /api/projects/:id/prompt-evolution/:runId
```

The platform:
1. Validates the request
2. Writes a job JSON to `data/prompt-evolution/`
3. Spawns the evolution script as a fire-and-forget subprocess
4. Serves the report markdown when the run completes

This turns prompt optimization from a local CLI tool into a **platform capability** that any project can use.

## Server-Side Execution

The platform API route runs **on the server** (fornace.net), not your laptop. The platform:

1. Spawns the evolution script as a background subprocess
2. Streams stdout to `data/prompt-evolution/<runId>.stdout`
3. Updates `progressLine` every 30 seconds so you can poll for status
4. Saves the final report to `data/prompt-evolution/<runId>/report.md`

Your laptop can be off the whole time.

> **Path discovery**: The route looks for claude-overnight in this order:
> 1. `CLAUDE_OVERNIGHT_REPO` environment variable
> 2. Sibling directory `../claude-overnight`
> 3. Global npm install (`npm i -g claude-overnight`)

## Usage Examples

### Local CLI

```bash
# Evolve a claude-overnight planner prompt
npm run evolve -- --prompt 10_planning/10-3_plan --eval-model claude-haiku-4-5 --generations 10

# Evolve an MCP-browser supervision prompt
npm run evolve -- --target mcp-browser --prompt-kind plan-supervision --eval-model kimi-k2-6 --generations 10
```

### Via Platform API (runs on server)

```bash
# Enqueue — returns immediately with runId
curl -X POST https://fornace.net/api/projects/my-project/prompt-evolution/enqueue \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "mcp-browser",
    "prompt": "plan-supervision",
    "evalModel": "claude-haiku-4-5",
    "generations": 20,
    "population": 10,
    "plateau": 5
  }'

# Poll for status and report
curl https://fornace.net/api/projects/my-project/prompt-evolution/evo_xxx \
  -H "Authorization: Bearer <token>"

# List all runs for a project
curl https://fornace.net/api/projects/my-project/prompt-evolution \
  -H "Authorization: Bearer <token>"
```

## Generation Counts & Early Stopping

Hermes typically runs **5–10 generations** for skill evolution, sometimes up to 20 for difficult targets. We default to **10 generations** with **early stopping** (plateau detection = 3 generations without improvement).

Why this matters:
- **Too few generations** (3) often gets stuck in a local optimum.
- **Too many generations** without early stopping wastes API budget.
- **Plateau detection** automatically stops when the population stops improving, so a run with `generations=50` might finish in 12 if the prompt converges early.

Recommended settings:

| Scenario | Generations | Population | Plateau | Expected Time |
|----------|-------------|------------|---------|---------------|
| Quick exploration | 10 | 8 | 3 | ~15 min |
| Serious optimization | 20 | 10 | 5 | ~40 min |
| Deep search | 50 | 12 | 5 | ~1.5 hr |

Time estimates assume a fast eval model (haiku/flash) and ~7 benchmark cases. The platform runs this server-side, so duration doesn't matter for your laptop.

## Benchmark Design

Good benchmarks are the whole game. Our fixtures (`src/prompt-evolution/fixtures/plan-cases.ts`, `adapters/mcp-browser.ts`) follow these principles:

1. **Cover budget tiers**: TIGHT (3–5 tasks), STANDARD (8–12), LARGE (35–40)
2. **Edge cases**: vague objectives, cross-cutting concerns, tiny objectives
3. **Objective auto-scoring**: task count, independence, specificity, schema compliance
4. **Deterministic hashes**: same (prompt, case) pair always has same identity

## Future Work

- **Parallel experiment execution**: Hermes autoresearch plans parallel branches; we currently run serially
- **Domain-specific rubrics**: LLM-judge criteria per prompt type (planning vs review vs supervision)
- **SessionDB mining**: Hermes mines real usage for eval datasets; we use synthetic fixtures
- **A/B testing in production**: promote evolved prompts behind a feature flag, measure real outcomes
- **Darwinian code evolution**: Hermes Phase 4 uses Darwinian Evolver for code; we could extend to tool descriptions

## References

- Hermes Agent Loop Internals: https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop
- Hermes Autoresearch Skill PR: https://github.com/NousResearch/hermes-agent/issues/4823
- Hermes Self-Evolution Repo: https://github.com/NousResearch/hermes-agent-self-evolution
- DSPy + GEPA (ICLR 2026 Oral): https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/PLAN.md
- PromptAid (Visual Analytics for Prompt Iteration): https://arxiv.org/html/2304.01964v3
