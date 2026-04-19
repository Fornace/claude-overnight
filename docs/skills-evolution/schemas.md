# Schemas — copy these verbatim

Everything in this file is a hard spec. Do not invent fields. If a new field is genuinely needed, write it to `HANDOFF.md` first, then update this file.

---

## 1. Candidate file (Phase 1 writes this)

Path: `~/.claude-overnight/skills/<repo-fingerprint>/candidates/<timestamp>-<agent-id>.md`

- `<timestamp>` = ISO 8601 with `:` replaced by `-` (e.g. `2026-04-19T23-04-12Z`).
- `<agent-id>` = the agent's swarm id, or `planner`, `steerer`, `verifier`, `thinking-wave-<n>`.

Body ≤ 5KB. Rejected silently (written to a dropped-log line) if oversize — candidates are cheap; don't retry at write time.

```yaml
---
kind: "skill" | "tool-recipe" | "heuristic"
proposed_by: string            # agent id or role
wave: integer                  # wave number at write time, or 0 pre-wave
run_id: string                 # run dir basename, e.g. "run-2026-04-19T23-00-00Z"
trigger: string                # one-line reason, ≤120 chars ("fix failed after silent tsc error")
status: "new"                  # librarian updates this on promotion
created_at: string             # ISO 8601 UTC
---

# Short title (H1)

What the skill is, in 1–3 sentences.

## When to apply

The signal that this is the right skill to load. Be specific to the repo, the
language, the toolchain.

## Steps / approach

The actual procedure. Can be prose, a checklist, or a short script template.
Do NOT paste logs or transcripts here — if you need evidence, reference a
transcript path instead.

## Caveats

Anything that would make this skill the wrong choice. Failure modes seen.
```

---

## 2. Canon skill file (Phase 2 promotes candidates into this)

Path: `~/.claude-overnight/skills/<repo-fingerprint>/canon/<skill-name>.md`

- `<skill-name>` = kebab-case, unique per fingerprint.
- Total file size ≤ 15,360 bytes (15KB). Enforced in librarian code — oversize promotion is rejected with a `LIBRARIAN.md` entry.
- Optional references under `canon/<skill-name>/references/*.md`. Each reference also ≤ 15KB. No recursion.

```yaml
---
name: string                   # kebab-case, primary key
description: string            # ≤120 chars — this is what L0 injection shows
version: integer               # bumped on every patch
applies_to:
  repo_fingerprint: string     # the 12-char fingerprint, or "*" for universal
  languages: [string]          # e.g. ["typescript", "tsx"], or ["*"]
  toolsets: [string]           # e.g. ["npm", "tsc", "node"], or ["*"]
requires_tools: [string]       # hard filter: skill hidden from L0 if any tool absent
triggers: [string]             # keywords that boost FTS5 match; 3–10 terms
references: [string]           # optional relative paths under references/
created_at: string             # ISO 8601 UTC
last_used_at: string | null    # updated by runtime on L1 hydration
telemetry:
  uses: integer                # L1 hydrations
  wins: integer                # verifier-pass runs that hydrated this skill
  losses: integer              # verifier-fail runs that hydrated this skill
  cost_saved_usd: number       # rough; see phase-3-ab-waves.md for computation
  last_wave: integer | null
source:
  candidate_ids: [string]      # filenames that were merged into this skill
  promoted_by: "librarian"
  promoted_at: string          # ISO 8601 UTC of first promotion
  patched_at: string | null    # ISO 8601 UTC of last patch
quarantined: boolean           # true = hidden from L0, kept for audit
---

# Short title (H1, matches description intent)

One-paragraph summary. This is visible at L1 hydration, not L0.

## When to apply

…

## Steps

…

## Caveats

…

## References (optional)

- [./references/example.md](./references/example.md) — what it covers
```

---

## 3. SQLite index

Path: `~/.claude-overnight/skills/index.sqlite`

Single-file SQLite database. Uses `better-sqlite3` (synchronous, fast, node-native). Add to dependencies in phase 2.

```sql
-- Primary table. One row per canon skill.
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  repo_fingerprint TEXT NOT NULL,
  description TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  languages TEXT NOT NULL,         -- JSON array string
  toolsets TEXT NOT NULL,          -- JSON array string
  requires_tools TEXT NOT NULL,    -- JSON array string
  triggers TEXT NOT NULL,          -- JSON array string
  body_path TEXT NOT NULL,         -- relative to ~/.claude-overnight/skills/
  size_bytes INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  cost_saved_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  last_wave INTEGER,
  quarantined INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS skills_by_fp        ON skills(repo_fingerprint);
CREATE INDEX IF NOT EXISTS skills_by_quar      ON skills(quarantined);
CREATE INDEX IF NOT EXISTS skills_by_last_used ON skills(last_used_at);

-- FTS5 virtual table for full-text search over metadata + body.
-- `content='skills'` + `content_rowid='rowid'` keeps FTS in sync with skills
-- via triggers below. Body is indexed but NOT stored in FTS — we store only
-- the rowid and re-read the md file on hydration.
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, triggers, body,
  content='skills', content_rowid='rowid'
);

-- Keep FTS in sync. Body is NULL in the shadow copy because we never store
-- full body in the DB — rowid + name is enough for the librarian to rebuild
-- the FTS row from the md file on demand.
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, triggers, body)
  VALUES (new.rowid, new.name, new.description, new.triggers, '');
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, triggers, body)
  VALUES('delete', old.rowid, old.name, old.description, old.triggers, '');
END;
CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, triggers, body)
  VALUES('delete', old.rowid, old.name, old.description, old.triggers, '');
  INSERT INTO skills_fts(rowid, name, description, triggers, body)
  VALUES (new.rowid, new.name, new.description, new.triggers, '');
END;

-- Telemetry events, append-only. Queried by librarian for GC decisions.
CREATE TABLE IF NOT EXISTS skill_events (
  ts TEXT NOT NULL,
  run_id TEXT NOT NULL,
  wave INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  event TEXT NOT NULL,            -- "hydrated" | "win" | "loss" | "cost_saved"
  value REAL,                     -- usd amount for cost_saved; NULL otherwise
  notes TEXT                      -- free-form, ≤200 chars
);
CREATE INDEX IF NOT EXISTS events_by_skill ON skill_events(skill_name);
CREATE INDEX IF NOT EXISTS events_by_run   ON skill_events(run_id);
```

---

## 4. L0 stub injection format

What the planner / wave agent sees in its prompt. Assembled by runtime at prompt-build time. Under 2K tokens total, always.

```
## Skills available (L0 stub)

You have N project-specific skills available. Call `skill_read(name)` to load
the full body on demand. Do not assume a skill matches — read it first.

- `deterministic-build-check` — re-run tsc after dist/ cleanup; exit 2 means stale ghosts.
- `planner-prompt-gc`        — drop merge-failed branches from status.md between waves.
- `cursor-proxy-restart`     — if 5xx, kill + respawn; skip if plan-phase just started.
…
```

**Hard rules for stub assembly:**
- Structural pre-filter first: `repo_fingerprint = current AND quarantined = 0 AND all requires_tools satisfied`.
- Within the filtered set, rank by `wins/uses` (default 0 if `uses=0`) then by `last_used_at DESC`.
- Truncate to fit 2K tokens. If truncation happens, mention the count remaining ("plus N more — use `skill_search(query)`").
- Never truncate mid-line. Never inject partial stubs.

---

## 5. `skill_read` / `skill_search` tools

Two new tools exposed to agents. Names match Hermes conventions so they're self-descriptive.

### `skill_read`

```ts
{
  name: "skill_read",
  description: "Read a skill's full body by name. Returns markdown ≤ 15KB. Records a hydration event.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact skill name from the L0 stub." },
      reference: { type: "string", description: "Optional reference filename (L2). Omit for the skill body." }
    },
    required: ["name"]
  }
}
```

Side effect on call: increments `skills.uses`, updates `last_used_at`, inserts `skill_events(event='hydrated')`.

### `skill_search`

```ts
{
  name: "skill_search",
  description: "FTS5 search over skill descriptions and triggers for the current repo. Returns up to 5 matches (name + description only — use skill_read for bodies).",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text query. Matched against name, description, triggers." }
    },
    required: ["query"]
  }
}
```

Side effect: none. Pure lookup.

---

## 6. Repo fingerprint function

```ts
// src/core/fingerprint.ts (new in phase 2)
export function computeRepoFingerprint(cwd: string): string {
  const remote = safeExec("git", ["-C", cwd, "config", "--get", "remote.origin.url"]);
  const source = remote?.trim() || realpathSync(cwd);
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}
```

Cached on `RunState` at run start. Never recomputed mid-run.

---

## 7. Size / count guards (enforced in code)

| Limit | Value | Enforced where |
|---|---|---|
| Candidate body | ≤ 5 KB | `scribe.ts:writeCandidate()` |
| Canon skill body (incl. frontmatter) | ≤ 15,360 bytes | `librarian.ts:promote()` |
| L2 reference file | ≤ 15,360 bytes | `librarian.ts:attachReference()` |
| L0 stub total | ≤ 2,048 tokens (≈ 8 KB) | `injection.ts:buildL0Stub()` |
| L1 hydrations per agent per wave | ≤ 5 | `message-handler.ts:skillReadGuard()` |
| Candidates per wave before librarian runs | ≤ 50 (then back-pressure) | `scribe.ts:writeCandidate()` |

Any limit hit surfaces as a one-line warning in the run log, never a crash.
