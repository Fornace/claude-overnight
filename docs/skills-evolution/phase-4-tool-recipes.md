# Phase 4 — Tool recipes

**Goal.** Let agents save and retrieve *recipes* for small helpers they keep rewriting — a shell snippet, a TypeScript utility, a `jq` pipeline — as a skill-subtype. Recipes are **markdown, not executable**. The agent always re-renders the code fresh in context; the recipe is a tested reference, not a runtime library.

**Time budget.** ~1 week. Only attempt after phases 1–3 have been in production for ≥ 2 weeks and the canon has settled.

**Ship criterion.** One overnight run produces a tool-recipe candidate, the librarian promotes it, a later run's agent reads it via `skill_read` and reproduces the helper correctly on its first attempt.

---

## Why recipes instead of executable tools

Hermes's self-evolution roadmap had Phase 4 as autonomous tool-code generation. We skip that: generating real executable code, versioning it, sandboxing it, and testing it per run is a huge surface area. Tool **recipes** (markdown with a tested code block inside) give 80% of the value — the agent remembers the exact approach that worked — at ≤ 10% of the surface area.

This is a deliberate scope choice, not a throwaway. Revisit "autonomous executable tools" only if recipes prove insufficient and only after a full ADAS-style eval harness is in place.

---

## Open these only when you need them

- [`schemas.md`](./schemas.md) — §1 candidate `kind` field, §2 canon `kind` (implicit in the body convention below).
- [`integration-map.md`](./integration-map.md) — "Phase 4 — tool recipes" row.

---

## What a recipe looks like on disk

Same canon schema as a skill, but:

- `name` prefixed `recipe/`. E.g. `recipe/npm-test-single-file`.
- Frontmatter adds one field:
  ```yaml
  recipe:
    language: "bash" | "typescript" | "javascript" | "jq" | "sql" | ...
    tested_with: [string]     # e.g. ["node 20.17", "npm 10.8"]
  ```
- Body must contain exactly one fenced code block tagged with `recipe.language`. Librarian rejects promotion if the body has zero or multiple code blocks of that language.

Path: `~/.claude-overnight/skills/<fp>/canon/recipe/<name>.md`.

---

## Injection contract

Recipes are **not** mixed into the default L0 stub. Mixing dilutes signal — an agent asking about "the build command" doesn't want a `jq` pipeline for log scrubbing in its top 10.

Instead, inject a **second, opt-in section** only when a recipe matches the *tool context*:

```
## Helpers you've written before (recipes)

- `recipe/npm-test-single-file` — run a single test file with reporter silent.
- `recipe/jq-transcript-tool-uses` — extract tool_use rows from NDJSON.
```

Rules:

- Only show recipes whose `requires_tools` intersects with the agent's available tools.
- Rank by same `wins/uses` as skills.
- Budget ≤ 512 tokens (quarter of skill L0). Truncate by count.
- If zero match, omit the section entirely.

---

## Sub-steps

### 4a — Scribe + librarian accept recipes (1 session)

1. Scribe: accept `kind: "tool-recipe"`. Route to `candidates/` as usual — no separate folder for candidates. Subtype is in the frontmatter.
2. Librarian prompt: extend to explain recipes; same promotion discipline, extra validation step:
   - Promote to `recipe/<name>` if and only if exactly one code block of the declared language is present.
   - Reject with an explicit line in `LIBRARIAN.md` if multiple or zero.
3. Librarian filesystem wiring: create `canon/recipe/` on first promote.

Acceptance: a seeded candidate with `kind: tool-recipe` + one code block gets promoted; a bad one with two code blocks gets rejected with reason.

### 4b — Second L0 section (1 session)

1. `src/skills/injection.ts`:
   - `buildRecipeStub({ fingerprint, tools }): { text, count } | null`. Separate function; do not entangle with the skills stub.
   - Emits the "Helpers you've written before" section or returns null.
2. Prompt assembly sites: call both `buildL0Stub` and `buildRecipeStub`; concat with a blank line. Order: skills first (behavioral guidance), recipes second (reference material).
3. Test:
   - With 2 recipes matching tools → both appear.
   - With 0 recipes → no section (not even a header).
   - Budget exceeded → truncate by count.

Acceptance: transcript shows both sections; zero-recipe case shows neither recipe header nor blank lines.

---

## System-prompt nudge

Add one line to the worker / planner prompt (not a new paragraph — extend the existing skill-candidate opt-in):

> Same rule applies to helpers (shell one-liners, jq/sql/ts utilities): if you
> wrote something non-trivial that worked, mark the candidate `kind:
> tool-recipe`, `recipe.language: <lang>`, and include exactly one fenced code
> block.

Do not over-specify. The model knows what a code block is.

---

## Acceptance checklist

- [ ] Scribe accepts `kind: "tool-recipe"` candidates.
- [ ] Librarian promotes valid recipes, rejects multi- or zero-block bodies.
- [ ] `recipe/` subdir created under canon automatically.
- [ ] `buildRecipeStub` emits the second L0 section only when matches exist.
- [ ] One real overnight run: candidate proposed → promoted → hydrated in a later run → agent re-renders the code.
- [ ] No file over 500 lines.

---

## Stop signals

- Tempted to execute the recipe's code block automatically. Stop — out of scope. Agent re-renders, agent decides.
- Tempted to version the code block separately from the skill. Stop — frontmatter `version` already bumps on any patch.
- Injection section grows past its 512-token cap. Stop — tighten descriptions; do not steal from the skill budget.

---

## End of the plan

After phase 4, the system has:

- Agents that propose candidates.
- A librarian that curates canon with telemetry-driven promotion, patching, and quarantine.
- Progressive disclosure retrieval (L0 metadata → L1 body → L2 reference).
- SQLite FTS5 + structural pre-filter for zero-embedding hot path.
- A/B waves as a swarm-native ablation engine.
- A second tier of markdown **recipes** alongside skills.

That's the Hermes architecture — adapted, with what Hermes punts on (skill-rot, telemetry-driven GC) turned into our differentiator.

Any further evolution (cross-repo skill transfer, embedding-based de-dup, autonomous tool-code generation) is a separate plan. Write it under `docs/` as its own doc when the time comes. Do not extend this one.
