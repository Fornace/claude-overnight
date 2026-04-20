# Phase 3 — A/B waves

**Goal.** Turn the swarm's parallelism into cheap ablations: for borderline candidates, inject the skill into one sibling branch and withhold it from another, then record the verifier-score delta as telemetry. This is the accelerator that Hermes doesn't have — a single-agent system can't run both arms simultaneously.

**Time budget.** ~1 week. Two sub-steps.

**Ship criterion.** Over a 1000-budget run with ≥ 3 waves and ≥ 4 concurrent agents, at least one skill's `wins/uses` ratio moves as a direct result of A/B assignment, and the librarian changes its promotion decision accordingly on the next run.

---

## Open these only when you need them

- [`schemas.md`](./schemas.md) — re-read §3 `skill_events` (especially `cost_saved_usd`).
- [`integration-map.md`](./integration-map.md) — "Phase 3 — A/B" row.

---

## Prerequisites

- Phase 2 is shipped. Librarian is running end-of-wave. L0 injection works. Telemetry (`skill_events`) is recording real hydrations.
- You have at least ~5 canon skills in the user's dir. If you don't, sit on phase 3 a little longer until you do — the A/B machinery is only valuable once there's something to ablate.

---

## Design

### What's eligible for A/B

Only skills the librarian is *undecided* about. Concrete criteria (librarian sets an `ab_eligible` column on the skills row; add in 2a DDL migration or lazy-add in 3a):

- Newly promoted (`created_at` within the last 7 days) AND `uses < 10`, OR
- Existing skills where the last 10 `skill_events` show `wins/uses < 0.5` — candidate for demotion, worth one more ablation before quarantine.

The librarian opts skills in/out explicitly; there is no implicit "everything gets A/B'd." If nothing is eligible, phase 3 is a no-op for the run.

### Arm assignment

At wave spawn, for each eligible skill pick **at most one** pair of sibling branches in the wave:

- **Treatment arm** — L0 stub includes this skill (plus the usual rank-ordered set).
- **Control arm** — L0 stub has this skill *explicitly removed* (everything else unchanged).

Rules:

- Never A/B-test more than one skill per pair in one wave. Confounding kills the signal.
- Only assign A/B when the wave has ≥ 2 parallel agents on comparable tasks. The existing planner decomposition already produces sibling tasks of similar shape; use the planner's task grouping as the eligibility gate.
- If the wave has only 1 agent, no A/B — just use the full L0 stub as normal.

### Outcome measurement

After the wave's verifier runs, record for the pair:

- `verifier_score_treatment`, `verifier_score_control` (0/1 pass, or the verifier's numeric score if available)
- `files_changed_treatment`, `files_changed_control`
- `cost_treatment_usd`, `cost_control_usd`

Write one `skill_events` row per arm:

- Treatment pass + control fail → `event='win'`, `notes='ab-vs-<control-branch>'`
- Treatment fail + control pass → `event='loss'`, `notes='ab-vs-<control-branch>'`
- Both pass or both fail → `event='tie'`, `notes='ab-inconclusive'` (no win/loss attributed)

`cost_saved_usd`:

- If treatment wins and control spent more, record `event='cost_saved'`, `value = cost_control - cost_treatment`.
- If treatment lost, record `event='cost_burned'`, `value = cost_treatment - cost_control` (negative attribution; librarian weighs this at demotion time).

---

## Sub-steps

### 3a — Assignment (1 session)

1. Add `ab_eligible INTEGER NOT NULL DEFAULT 0` and `ab_last_trial_run TEXT` to `skills`. Migration: `ALTER TABLE` if cols missing (pragma `table_info`).
2. `src/skills/ab.ts`:
   - `pickAbSkill({ fingerprint, waveAgents, db }): { skill, pair } | null`. Returns one skill + a pair of agent ids (treatment, control) or null.
   - Pair pick: agents with the closest-matching task (planner assigns `groupId`; if present, pick two in the same group; fallback: any two).
   - Pure — takes db handle, returns the decision. Does not mutate anything.
3. `src/run/wave-loop.ts`:
   - Before dispatching the wave, call `pickAbSkill(...)`. If non-null, store the assignment on the wave context.
4. `src/skills/injection.ts`:
   - `buildL0Stub(...)` takes an optional `excludeSkill: string`. When building the control arm's stub, pass it.
   - Also: never exclude a skill *and* silently reduce the list. Still rank-fill up to budget after exclusion.
5. Log per wave: `ab: skill=<name> treatment=<agentId> control=<agentId>` or `ab: none`.

Acceptance: mock a wave with 2 agents, one eligible skill — `pickAbSkill` returns a pair; treatment's rendered stub includes the skill, control's does not; log line appears.

### 3b — Outcome capture (1 session)

1. `src/skills/ab.ts`:
   - `recordAbOutcome({ pair, treatment, control, db })`. Writes the three-or-so `skill_events` rows as specified above.
2. `src/run/wave-loop.ts`:
   - After verifier finishes and scores are available, call `recordAbOutcome(...)`. Tolerate missing scores (log and skip).
3. `src/skills/librarian.ts`:
   - Before proposing `quarantine` for a losing skill, check `skill_events` for any `ab-inconclusive` rows — if there are still inconclusive trials, let it run one more wave instead of quarantining.
   - Feed a compact A/B summary into the librarian subagent's input: for each A/B'd skill, its trial count, win/loss/tie counts, and cumulative `cost_saved_usd`.
4. Tests:
   - `src/__tests__/ab.test.ts` — given scores, `recordAbOutcome` writes the right events. Ties record neither win nor loss. Negative cost attribution works.

Acceptance:
- Run with seeded skill → one wave A/B's it → `skill_events` shows the trial → librarian next pass references the outcome.
- Real overnight run (burn-in) — at least one skill's `wins/uses` changes between run 1 and run 2 *because of* an A/B assignment (not baseline hydrations).

---

## Cost accounting — be honest

`cost_saved_usd` is a rough estimate, not a financial number. The rule:

- Only emit `cost_saved`/`cost_burned` when treatment and control diverged in outcome. Ties get no cost attribution.
- Use `accCostIn + accCostOut` delta between the two agents (available in the swarm state).
- Cap a single event's value at `$2.00` (sanity clamp — wild differences usually mean something confounded).

This column is telemetry, not accounting. Never display it in a way that looks authoritative. In `run.ts` end-of-run summary, label it `est. skill cost attribution` with a tilde.

---

## Non-goals for phase 3

- Multi-variate testing (multiple skills per wave). Confounding is too severe at our scale.
- Cross-wave A/B carryover. Each wave is independent; a skill winning once then losing once is exactly the noise we want the librarian to weigh.
- Global / cross-repo telemetry. Per-fingerprint for now. Cross-repo learnings can come later once we see what's stable.

---

## Acceptance checklist

- [ ] `ab_eligible` column present; librarian sets it on promotion / demotion-consideration.
- [ ] `pickAbSkill` returns at most one pair per wave.
- [ ] Treatment stub contains the skill; control stub does not; nothing else differs.
- [x] `recordAbOutcome` writes the expected `skill_events` rows for win / loss / tie.
- [x] Librarian subagent input includes a compact A/B summary per eligible skill.
- [x] `src/__tests__/ab.test.ts` passes.
- [ ] One real overnight run produces a non-tie A/B outcome and the librarian cites it in its next pass.
- [ ] No file over 500 lines.

---

## Stop signals

- Tempted to A/B more than one skill per wave. Stop — confounds. One per wave.
- Tempted to extend A/B to the planner's initial-plan phase. Stop — not parallelized; no control arm. Waves only.
- Pair picker keeps returning `null` because wave concurrency is too low. Stop — not a phase-3 bug; upstream issue in planner decomposition. Write to HANDOFF.md and open a separate ticket.

---

## Hand-off to phase 4

After phase 3, the librarian has real `wins/losses/cost_saved` telemetry driven by the swarm's own ablations. Skills that earn their keep survive; skills that don't get quarantined automatically.

Phase 4 extends the same machinery to a tool-recipe subtype. Open [`phase-4-tool-recipes.md`](./phase-4-tool-recipes.md).
