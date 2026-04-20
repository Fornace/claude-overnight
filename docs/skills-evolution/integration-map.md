# Integration map — where to hook in

One source of truth for file paths. When a phase says "wire the scribe into agents," this file tells you exactly which file and where.

If a referenced line range is off by more than ~10 lines by the time you read it, grep for the nearest nearby symbol instead of trusting the range. Then fix this file.

---

## Files to create

| Phase | Path | Responsibility | Size target |
|---|---|---|---|
| 1 | `src/skills/scribe.ts` | `writeCandidate()` — append candidate md to queue dir; enforce 5KB cap; never throws. | ≤ 100 lines |
| 1 | `src/skills/paths.ts` | User-dir resolution, fingerprint-scoped subpaths. Pure. | ≤ 60 lines |
| 2 | `src/core/fingerprint.ts` | `computeRepoFingerprint(cwd)`. Pure. | ≤ 40 lines |
| 2 | `src/skills/index-db.ts` | SQLite open / migrate / query wrappers. `better-sqlite3`. | ≤ 200 lines |
| 2 | `src/skills/injection.ts` | `buildL0Stub(fingerprint, context)`. Pre-filter + rank + truncate. Pure (takes db handle). | ≤ 150 lines |
| 2 | `src/skills/tools.ts` | `skill_read` / `skill_search` tool implementations registered with the SDK. | ≤ 150 lines |
| 2 | `src/skills/librarian.ts` | End-of-wave librarian pass. Spawns a subagent via `query()`. | ≤ 300 lines |
| 2 | `src/skills/librarian-prompt.ts` | Exported prompt string (the one in `librarian-prompt.md`). | ≤ 60 lines |
| 2 | `src/skills/skills.ts` | Entry re-exports the folder's public API (the `swarm/swarm.ts` pattern). | ≤ 50 lines |
| 3 | `src/skills/ab.ts` | A/B wave injection: pick one candidate to inject into one sibling branch; record outcome. | ≤ 200 lines |

All new code lives under `src/skills/`. New subfolder — follow the `planner/`, `swarm/`, `ui/` pattern. Flat inside.

---

## Files to edit

### Phase 1 — scribe wiring

| File | Where | What to add |
|---|---|---|
| `src/swarm/agent-run.ts` | at agent completion (look for the `runAgent` return / settle block) | `writeCandidate()` call with the agent's own summary if the agent opted-in via a system-prompt hook. Pass `{kind:'skill', proposed_by:agentId, wave, run_id, trigger, body}`. |
| `src/planner/query.ts` | after each planner / verifier / steerer call returns | Same `writeCandidate()` hook, role-tagged. |
| `src/run/wave-loop.ts` | after wave settles, before summary | Emit a `wave-summary` candidate with the wave's objective + outcome so the librarian has provenance. |
| `src/state/state.ts` | `RunState` | Add `repoFingerprint: string`. Populated at run start. |

The scribe must never throw. All writes wrapped in try/catch; failures logged to the run's debug log but never surfaced to the user or abort the run.

### Phase 2 — librarian + index + injection

| File | Where | What to add |
|---|---|---|
| `src/run/wave-loop.ts` | end of wave, after steering, before next wave starts | `await runLibrarian({ fingerprint, runId, wave })`. Time-boxed to 60s; if exceeds, log and continue. |
| `src/planner/query.ts` | prompt construction site (search for the first `system:` or `systemPrompt` assembly) | Prepend the L0 stub from `buildL0Stub()`. Token-budget accounted for. |
| `src/swarm/agent-run.ts` | same — wave-agent prompt construction | Same L0 injection. Stub may differ (worker-flavored ranking); same function with a role flag. |
| `src/swarm/message-handler.ts` | tool-use dispatch | Route `skill_read` / `skill_search` to `src/skills/tools.ts`. Enforce per-agent hydration cap (5/wave). |
| `src/run/run.ts` | end-of-run summary print | Include a one-line `Skills: hydrated=N, promoted=M, quarantined=Q`. Same place `printFinalSummary` lives. |

### Phase 3 — A/B

| File | Where | What to add |
|---|---|---|
| `src/run/wave-loop.ts` | wave spawn | If a candidate is eligible for A/B, pick one sibling branch as the "treatment"; inject only into that one; record the pairing. |
| `src/skills/librarian.ts` | promotion decision | Read A/B outcome from `skill_events` before promoting borderline candidates. |

### Phase 4 — tool recipes

| File | Where | What to add |
|---|---|---|
| `src/skills/paths.ts` | paths | `recipeDir(fp)` — returns `canon/recipe/` subdir. |
| `src/skills/scribe.ts` | candidate validation | Already accepts `kind: "tool-recipe"` in `CandidateInput.kind`. No change needed. |
| `src/skills/index-db.ts` | DB | Added `kind` column (lazy migration). `queryRecipeL0()` queries recipes by kind. Updated `queryCandidateL0` to filter `kind = 'skill'`. |
| `src/skills/injection.ts` | L0 | `buildRecipeStub()` — emits "Helpers you've written before" section when recipes match agent tools. ≤ 512 tokens. |
| `src/skills/librarian.ts` | promotion | `validateRecipeBody()` — validates exactly one code block of declared language. Creates route to `canon/recipe/` for recipes. `insertSkillRow` now takes `kind`. |
| `src/skills/librarian-prompt.ts` | prompt | Extended with recipe-specific fields (`recipe_language`, `tested_with`) and validation rules. |
| `src/swarm/config.ts` | SKILL_PROPOSAL_PROMPT | Added recipe candidate paragraph. |
| `src/swarm/agent-run.ts` | prompt assembly | Calls `buildRecipeStub`, injects after skills stub. |
| `src/planner/query.ts` | prompt assembly | Calls `buildRecipeStub`, prepends before skills stub. |

---

## Integration anchor patterns

Use these grep patterns to find the right hook when line ranges drift:

- Planner prompt assembly — `grep -n "systemPrompt" src/planner/query.ts`
- Agent prompt assembly — `grep -n "systemPrompt" src/swarm/agent-run.ts`
- Wave completion — `grep -n "wave-summary\|waveHistory" src/run/wave-loop.ts`
- Tool-use dispatch — `grep -n "tool_use" src/swarm/message-handler.ts`
- Run-state shape — `grep -n "export interface RunState\|export type RunState" src/state/state.ts`
- Final summary — `grep -n "printFinalSummary" src/run/*.ts`

---

## Dependency add in phase 2

One new runtime dep:

```bash
npm i better-sqlite3@^11
npm i -D @types/better-sqlite3
```

`better-sqlite3` is synchronous (no promise noise), prebuilt binaries for all our supported Node versions, FTS5 built in. No other SQLite wrapper comes close for this workload.

No other new deps across the four phases. `p-retry` / `@inkjs/ui` / `@logdna/tail-file` are unrelated (they belong to the streaming-UI work).

---

## What NOT to touch

- `~/.claude/projects/.../memory/` — this is the user's auto-memory, scoped to the conversation, separate system. Skills live in `~/.claude-overnight/`, not there.
- The target repo's working tree. The librarian and scribe **never** write to the repo being worked on. Only to `~/.claude-overnight/skills/`.
- `dist/` — regenerated by build.
- `CLAUDE.md`, `HANDOFF.md` — untracked, local-only; feel free to append session logs to `HANDOFF.md`.
