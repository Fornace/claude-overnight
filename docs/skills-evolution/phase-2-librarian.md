# Phase 2 — Librarian, index, L0 injection

**Goal.** Close the retrieval loop. Candidates from phase 1 get promoted into canon by a librarian subagent at end-of-wave. Future agents see an L0 stub of available skills; they pull L1 bodies on demand via `skill_read`.

**Time budget.** ~2 weeks. Four independently reviewable sub-steps; do not bundle.

**Ship criterion.** An overnight run's second wave hydrates at least one skill that was written during the first wave, and the per-wave log shows `skills: hydrated=N promoted=M quarantined=Q` cleanly.

---

## Open these only when you need them

- Schemas: [`schemas.md`](./schemas.md) — all sections.
- File map: [`integration-map.md`](./integration-map.md) — "Phase 2 — librarian + index + injection" row, plus "Files to create" rows flagged phase 2.
- Librarian prompt: [`librarian-prompt.md`](./librarian-prompt.md) — open this only when editing `src/skills/librarian-prompt.ts`.

Do not read `phase-3-ab-waves.md` yet.

---

## Sub-steps (strict order)

### 2a — Fingerprint + DB bootstrap (1 session)

1. Create `src/core/fingerprint.ts` per schemas.md §6. Replace the phase-1 private helper inside `scribe.ts` with an import. Delete the private helper.
2. `npm i better-sqlite3@^11 && npm i -D @types/better-sqlite3`.
3. `src/skills/index-db.ts`:
   - `openSkillsDb()` — opens at `skillsRoot()/index.sqlite`, `mkdirSync` the dir, runs the full DDL from schemas.md §3. Idempotent.
   - `queryCandidateL0(fp, ctx)` — returns rows matching `repo_fingerprint = fp AND quarantined = 0` plus `ctx.availableTools` superset check for `requires_tools`. Order by `wins/nullif(uses,0)` desc, then `last_used_at` desc. Limit 30.
   - `recordEvent(runId, wave, skill, event, value?, notes?)` — inserts into `skill_events`.
   - `incrementUse(skillName)` — `UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE name = ?`.
4. `src/__tests__/index-db.test.ts` — open / migrate / insert / FTS5 roundtrip.

Acceptance: build green, tests green, `node -e 'require("./dist/skills/index-db.js").openSkillsDb()'` creates the file.

### 2b — Librarian subagent (2 sessions)

1. `src/skills/librarian-prompt.ts` — export the prompt from `librarian-prompt.md` as a template string. Do not inline the prompt anywhere else.
2. `src/skills/librarian.ts`:
   - Entry: `runLibrarian({ fingerprint, runId, wave })`. Time-boxed to 60s; on timeout, log and return.
   - Reads all candidates for the fingerprint, reads the canon directory listing (names + descriptions only, never full bodies), prepares a compact input for the subagent: candidate list + canon metadata. **Never feed the subagent full bodies.**
   - Spawns the subagent via the same `query()` mechanism as the planner (`src/planner/query.ts`). Model: whatever the run's planner model is. Use a short deterministic system prompt from step 1.
   - The subagent returns a JSON array of actions:
     ```json
     [
       {"action":"create","name":"...","description":"...","triggers":[...],"body":"..."},
       {"action":"patch","name":"...","patch":"...","description":"..."},
       {"action":"quarantine","name":"...","reason":"..."},
       {"action":"reject_candidate","candidate_file":"...","reason":"..."}
     ]
     ```
     Use the SDK's structured-output mode; do not post-parse markdown.
   - Apply actions:
     - `create` — write canon md (validate ≤15KB), insert DB row.
     - `patch` — apply diff to existing canon md (size check), bump version, set `patched_at`.
     - `quarantine` — move md to `quarantine/`, set `quarantined=1` in DB.
     - `reject_candidate` — move candidate to a `dropped/` sibling dir, log to `LIBRARIAN.md`.
   - After apply, move the consumed candidates to `processed/` (sibling of `candidates/`) with a dated subdir. This is the audit trail.
   - Append one section to `~/.claude-overnight/skills/LIBRARIAN.md` per run: promotions, patches, quarantines, rejections, all one line each with reasons.
3. Call `runLibrarian(...)` in `src/run/wave-loop.ts` at end of wave, inside the existing loop body. Wrap in try/catch; failures log, do not abort.
4. Tests:
   - `src/__tests__/librarian-apply.test.ts` — given a fake subagent output, actions are applied correctly (filesystem + DB both).
   - Size-cap enforcement: a `create` action with 20KB body → rejected, logged.
   - Patch idempotency: applying the same patch twice → second is a no-op, version bumped once.

Acceptance: run twice in a row against a candidate fixture; second run shows skill in DB, L0 query returns it.

### 2c — L0 injection (1 session)

1. `src/skills/injection.ts`:
   - `buildL0Stub({ fingerprint, role, tools }): { text: string, count: number, remaining: number }`.
   - Calls `queryCandidateL0`, applies final token-budget truncation (≤ 2048 tokens estimated; use `src/planner/steering.ts` helper if there's one, else `Math.ceil(chars/4)`).
   - Never returns a partial skill stub. If the next skill won't fit, stop.
   - Output text matches schemas.md §4 verbatim.
2. Hook into prompt construction:
   - `src/planner/query.ts` — grep for the first systemPrompt assembly; prepend the stub.
   - `src/swarm/agent-run.ts` — same, with `role: "worker"`.
3. Do **not** inject the stub into the librarian's own subagent. The librarian already has the metadata it needs; injecting would be circular.

Acceptance:
- Smoke-run a target with ≥ 1 canon skill present. First agent's transcript shows the L0 stub in its system prompt.
- With zero canon skills, the stub is omitted entirely (no empty section header).

### 2d — `skill_read` / `skill_search` tools (1 session)

1. `src/skills/tools.ts`:
   - Two tool definitions per schemas.md §5.
   - `skill_read` body loader reads from disk, not DB. Records hydration event. Enforces per-agent per-wave cap of 5 (counter kept in a WeakMap keyed on agent id, or on the wave-scoped host object).
   - `skill_search` runs `MATCH` against `skills_fts`, returns up to 5 `{name, description}` pairs. No bodies.
2. Register tools in `src/swarm/message-handler.ts` (tool-use dispatch) and the planner/verifier equivalent. Look for the existing tool registry; follow the same pattern.
3. Tests:
   - `src/__tests__/skill-tools.test.ts` — skill_read returns body, records event, respects cap.
   - skill_search returns ranked matches, respects repo fingerprint filter.

Acceptance:
- Wave agent calls `skill_read("foo")` → tool result is the md body, DB row `uses` incremented by 1.
- Sixth call in the same wave → returns a short error message ("hydration cap reached; use skill_search to refine"); does not hydrate, does not crash.

---

## Wave-loop observability

Add to the end-of-wave log:

```
skills: stub_skills=<K> hydrated=<N> promoted=<M> patched=<P> quarantined=<Q> rejected=<R> librarian_ms=<T>
```

Also surface `promoted/patched/quarantined` in the run-complete summary print in `src/run/run.ts`.

---

## GC and quarantine rules (librarian applies; also callable manually)

The librarian runs these *before* proposing `create`/`patch`. Pure DB queries, no LLM needed for these:

- **Stale-use.** `last_used_at IS NOT NULL AND last_used_at < now - 14 days AND uses > 3` → candidate for quarantine. Only the subagent confirms; librarian proposes it in the subagent's input as a "candidate for demotion."
- **Losing.** `uses >= 10 AND wins / uses < 0.3` → same.
- **Duplicate.** Two skills with FTS5 similarity > 0.85 on description+triggers → pass both to the subagent with a `merge_candidates` hint.

No auto-delete ever. Quarantine only. Deletion is a manual step the user runs with `claude-overnight skills prune`.

---

## Bounded failure modes

| Failure | Effect | Recovery |
|---|---|---|
| SQLite file corrupt | `openSkillsDb` throws | Rename to `.bak`, rerun librarian with `--reindex` (rebuilds from md source of truth). |
| Librarian subagent times out | Candidates stay in queue | Next wave's librarian picks them up. No work lost. |
| `skill_read` for missing name | Tool returns error, wave continues | Log as `skill_events(event='read_miss')`. Librarian uses miss-rate to detect rot. |
| L0 stub overflows budget | Truncation branch taken | Stub is always truncated at whole-skill boundaries; never ragged. |

---

## Acceptance checklist

- [ ] `better-sqlite3` added; `npm test` green on fresh clone.
- [ ] `openSkillsDb()` is idempotent; re-running never breaks.
- [ ] Librarian runs end-of-wave, ≤ 60s budgeted, failures logged not thrown.
- [ ] Subagent receives metadata only, never full canon bodies.
- [ ] Every promotion writes a line to `LIBRARIAN.md`.
- [ ] L0 stub matches schemas.md §4 verbatim; ≤ 2K tokens; never partial.
- [ ] Zero-skill case injects no stub at all.
- [ ] `skill_read` increments DB telemetry; cap enforced.
- [ ] `skill_search` returns names+descriptions only.
- [ ] Two smoke runs in a row: second run's first wave hydrates a skill written in run 1.
- [ ] No file over 500 lines.

---

## Stop signals — write to HANDOFF.md and stop

- You're tempted to inject skill bodies into the L0 stub. Stop — that's L1, not L0.
- You're tempted to feed the librarian subagent full canon bodies. Stop — metadata only.
- You're tempted to auto-delete skills. Stop — quarantine only.
- You're adding embeddings. Stop — not on the hot path. If de-dup needs it, keep it offline inside the librarian and do not ship it with phase 2; write to HANDOFF.md first.
- `LIBRARIAN.md` grows past ~200 lines per run. Stop — the librarian is too chatty; tighten its prompt to one-line-per-action.

---

## Hand-off to phase 3

When acceptance is green:

- Candidates flow → librarian curates → canon exists → index is queryable → agents see L0 → agents hydrate L1 → telemetry records uses.

Phase 3 turns the parallel swarm into an ablation engine that tells us *which* skills earn their keep. Open [`phase-3-ab-waves.md`](./phase-3-ab-waves.md).
