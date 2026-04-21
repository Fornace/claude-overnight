# Overnight Run Recipes

Scenario → recommended run shape. These are defaults, not laws, adjust when the repo or user constraints say so. Always pair with `authoring.md` (decision tree + pre-flight).

## Recipe matrix

| Scenario | Shape | `flexiblePlan` | Budget | Concurrency | Planner / Worker | Skip phases | Notes |
|---|---|---|---|---|---|---|---|
| **Fixed refactor** (concrete file list, clear endpoint) | `tasks.json` with explicit tasks | `false` (`--no-flex`) | 1× tasks + ~20% headroom | 3–5 | Sonnet / Sonnet | thinking wave, post-wave review | Each task = one cohesive unit of work. Cheapest mode. |
| **Feature batch** (N independent features) | `tasks.json`, one task per feature | `false` initially; `true` if features bleed into shared code | 2–3× feature count | 4–6 | Opus / Sonnet | thinking wave if features are well-scoped | Require verify-before-done per task. |
| **Framework migration** (Next 14→16, React 18→19, etc.) | `objective` + seed tasks per package | `true` | 50–200 | 3–5 | Opus / Sonnet | none, keep thinking + review | Steering re-plans as breakage surfaces. `beforeWave`: install deps. |
| **Test sprint** (raise coverage, fill gaps) | `objective` + seed per module | `true` | 30–100 | 5–8 | Sonnet / Sonnet (or Qwen for cost) | thinking if coverage report is attached | `afterWave`: run test suite, feed failures forward. |
| **Docs sprint** (API docs, guides) | `tasks.json` per doc surface | `false` | 1× docs + 10% | 4–6 | Sonnet / Sonnet (or Qwen) | thinking wave, reflection | Pure output task, flex mode wastes planner. |
| **Bug hunt** (unknown cause, repro unstable) | `objective` + the repro | `true` | 20–80 | 2–4 | Opus / Opus | none | Low concurrency, workers step on each other on shared bug surface. Verify fix via reproduction script. |
| **Codebase audit / research** (no code changes) | `objective` + focus list | `true` | 30–80 | 5–10 | Opus / Sonnet | n/a, architects *are* the work | Output is `designs/*.md` + `milestones/`. Set `permissionMode: "default"` so workers can't write. |
| **Framework-wide cleanup** (dead code, consistency) | `objective` + seed tasks | `true` | 100–300 | 5–8 | Opus / Sonnet + fast Qwen | thinking if scope is obvious | Use fast worker for well-scoped mechanical tasks. |
| **Long research run** (exploration, prototypes) | `objective` + loose tasks | `true` | 200–1000 | 3–5 | Opus / Opus | none | `usageCap: 90`, `--allow-extra-usage` off unless explicitly requested. |

## Budget heuristics

- **Per-wave cost floor** ≈ $2–4 planner + $N workers × avg task cost (Sonnet ≈ $0.15–0.40, Opus ≈ $0.50–1.50, Qwen ≈ <$0.05). Budget must cover *expected waves × per-wave cost*, not just task count.
- **Thinking wave cost** scales with budget: 5 architects at budget=50 (~$3–8), 10 at budget=2000 (~$15–40). Skip when you don't need exploration.
- **Flex overhead**: each steering pass is one planner call (~$0.50–2 on Opus). For 10-wave flex runs, reserve ~$10 for steering alone.

## Model pairing defaults

| Run type | Planner | Main worker | Fast worker |
|---|---|---|---|
| High-stakes (production refactor, migration) | Opus | Sonnet | Haiku or Kimi 2.6 (optional) |
| Everyday (features, tests, cleanups) | Sonnet | Sonnet | Qwen 3.6 Plus |
| Cost-sensitive (docs, mechanical batch) | Sonnet | Qwen 3.6 Plus | (none) |
| Research / audit (read-heavy) | Opus | Opus | (none) |

Rationale: planner quality is the ceiling for the whole run. Never cheap out on planner unless the run is purely mechanical.

## Phase-skip cheatsheet

- **Skip thinking wave** when: tasks are already concrete · user has already explored the code · scenario is "docs/tests/mechanical batch" · budget < 15 (auto-skipped).
- **Skip flex / steering** (`--no-flex`) when: endpoint is crisp · tasks are independent · no assessment needed between waves.
- **Skip post-wave review** when: single-wave run · budget is tight · tasks are trivially verifiable (docs, formatting).
- **Always keep final gate** (post-run review) unless `--dry-run`. It's the last quality check before the diff lands.

## Anti-recipes (don't do these)

- "Do everything in `src/`" → one agent, no decomposition. See `authoring.md` → *decompose fallback*.
- `budget=5` + `flexiblePlan: true` → planner eats most of the budget, workers starve.
- High concurrency on shared-file scenarios (migrations, bug hunts) → merge conflicts dominate. Drop to 2–4.
- `usageCap: 100` + `--allow-extra-usage` without `--extra-usage-budget` → silent overage. Always cap extra spend explicitly.
