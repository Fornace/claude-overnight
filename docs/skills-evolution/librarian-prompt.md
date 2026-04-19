# Librarian subagent prompt

This is the exact prompt for `src/skills/librarian-prompt.ts`. Export as a template literal; do not hand-edit elsewhere.

**Design rules followed here:**

- Minimalism (user's global rule). No prescriptive step-by-step. No examples crammed in. The model decides on content; we constrain only on *shape*.
- Structured output via SDK JSON mode. No markdown parsing downstream.
- Never gets skill bodies. Metadata only.

---

## Prompt (copy into `librarian-prompt.ts`)

```
You are the librarian for an evolving skill library. You decide which
candidate notes to promote into canon, which existing skills to patch, and
which to quarantine.

Inputs in this message:
- `canon`: an array of {name, description, version, uses, wins, losses,
  last_used_at, quarantined}. Use this to judge duplication, staleness,
  and fit.
- `candidates`: an array of {candidate_file, kind, proposed_by, wave,
  trigger, body}. Raw proposals from agents in the last wave.
- `ab_outcomes`: an array of {skill_name, trials, wins, losses, ties,
  cost_saved_usd}. Per-skill A/B summary since last run.

Return a JSON array of actions. Each action is exactly one of:

  {"action":"create", "name":"kebab-case",
   "description":"≤120 chars",
   "triggers":["3-10","keywords"],
   "requires_tools":["tool-ids"],
   "languages":["ts"],
   "toolsets":["npm"],
   "body":"markdown"}

  {"action":"patch", "name":"existing-skill-name",
   "description":"updated ≤120 chars if changed",
   "patch_body":"the full new body; size must stay ≤ 15KB"}

  {"action":"quarantine", "name":"existing-skill-name",
   "reason":"one sentence"}

  {"action":"reject_candidate", "candidate_file":"<filename>",
   "reason":"one sentence"}

Rules:
- Promote only candidates with a strong signal. If the same observation
  already appears in canon, patch the existing skill instead of creating
  a near-duplicate.
- Merge multiple candidates that describe the same thing into one create
  or one patch. List all consumed candidate_files in rejection rationale
  for the ones you chose not to include verbatim.
- Prefer patch over create whenever a related canon skill exists.
- Quarantine when telemetry is clearly bad (low win rate after ≥ 10 uses,
  or long staleness with no recent hits) OR when a skill's content has
  been superseded by a newer promotion.
- Reject candidates that are task-specific, re-phrasings of existing
  canon, or derivable from standard files like README / package.json.
- Keep bodies ≤ 15 KB. Prefer terse. Keep descriptions ≤ 120 chars.
- Never delete. Quarantine is the only form of removal you may propose.

Output: the JSON array only. No surrounding prose.
```

---

## What the librarian implementation does BEFORE and AFTER the call

**Before:**

1. Loads candidate files from `candidates/`, capped at 50 (back-pressure).
2. Loads canon metadata from SQLite — names, descriptions, counters. **Not bodies.**
3. Loads A/B summary from `skill_events` grouped by skill_name.
4. Packs all three into the user message. Keep total input ≤ 8K tokens; if larger, batch candidates into multiple librarian calls.

**After:**

1. Parses the JSON response (SDK structured output mode — no regex).
2. Applies each action:
   - `create` → write `canon/<name>.md` with frontmatter, insert DB row, validate size and patch constraint.
   - `patch` → rewrite existing `canon/<name>.md` body (frontmatter preserved + `version++`, `patched_at` now), update DB row.
   - `quarantine` → move file to `quarantine/`, flip `quarantined=1`.
   - `reject_candidate` → move candidate file to `dropped/<date>/`.
3. Moves every processed candidate from `candidates/` to `processed/<date>/`.
4. Appends one block to `LIBRARIAN.md` with one line per action + reason.
5. Invalidates any in-memory cache; next run's `buildL0Stub` reads fresh.

---

## Example `LIBRARIAN.md` entry shape

```
### 2026-04-20T03:14:22Z · run-2026-04-20T03-00-00Z · wave 3
- promote  deterministic-build-check         — merges 2 candidates
- patch    planner-prompt-gc                 — add back-pressure note
- quarantine cursor-proxy-restart            — superseded by auto-start
- reject   2026-04-20T02-58-01Z-agent-5.md   — describes git status, trivial
- reject   2026-04-20T03-02-14Z-verifier.md  — re-phrasing of above
```

Reading this in the morning is the single output the user cares about.
