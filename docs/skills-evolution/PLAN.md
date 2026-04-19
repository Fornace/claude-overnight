# Skills evolution — plan

> Inspired by Nous Research's **Hermes Agent** (Feb 2026): agents write their
> own markdown **Skills**, a **librarian** curates them, retrieval uses
> **progressive disclosure** (metadata → body → refs) over **SQLite FTS5** so
> context never bloats. We go further than Hermes on skill-rot by tracking
> last-used, win-rate, and cost-per-use per skill and auto-quarantining stale
> ones. Our parallel swarms are the accelerator: every wave is a free
> A/B trial.

---

## How to read this plan

**This file is the entry point. Do not read the phase or artifact files until you need them.**

Each phase is independently shippable and delivers measurable value. Do not bundle phases. Work strictly in order: 1 → 2 → 3 → 4. If you get stuck, stop and append to `HANDOFF.md` in the repo root — do not plow through.

Files under `docs/skills-evolution/`:

| When to open | File | What it contains |
|---|---|---|
| Starting phase 1 | [`phase-1-scribe.md`](./phase-1-scribe.md) | Candidate writer — agents append `.md` files to a queue. No retrieval yet. |
| Starting phase 2 | [`phase-2-librarian.md`](./phase-2-librarian.md) | Librarian agent + SQLite FTS5 index + L0 injection into planner. |
| Starting phase 3 | [`phase-3-ab-waves.md`](./phase-3-ab-waves.md) | A/B skill injection across sibling branches; feedback into telemetry. |
| Starting phase 4 | [`phase-4-tool-recipes.md`](./phase-4-tool-recipes.md) | Tool-recipe promotion (markdown, not executable code). |
| Writing any phase | [`schemas.md`](./schemas.md) | Frontmatter specs + SQLite DDL + JSON shapes. Copy-pastable. |
| Writing phase 2 | [`librarian-prompt.md`](./librarian-prompt.md) | The exact prompt for the librarian subagent. |
| Any phase that touches existing code | [`integration-map.md`](./integration-map.md) | File-path + line-range map of where to hook in. |

**Stop rule.** Do not read a file you don't need right now. If phase 2 is working as specified, you do not need `phase-3-ab-waves.md`. This is the whole point — we practice what we preach about context budgets.

---

## Non-negotiables (the north star)

1. **Skills live on disk as markdown.** SQLite is an index, not the truth. Every skill is diffable, grep-able, git-able, human-editable.
2. **Progressive disclosure, always.** No agent ever sees the full skill library in its prompt. L0 = metadata stubs (~2K tokens max). L1 = one body on demand. L2 = one reference file on demand.
3. **Patch, don't rewrite.** Librarian updates existing skills via diff-style patch whenever possible. Preserves cache, keeps changes reviewable, survives bisect.
4. **Hard caps.** Skill body ≤ 15KB. L0 stub ≤ 2K tokens per agent. Per-agent hydrated L1 budget ≤ 5 skills. These caps are enforced in code, not by convention.
5. **Human PR gate.** The librarian never commits to the user's target repo. It writes to `~/.claude-overnight/skills/` and emits `LIBRARIAN.md` per run for morning review. Promotions into canon are a batch diff the user approves.
6. **No embeddings on the hot path.** FTS5 + structural pre-filter (repo fingerprint, language, toolset). Embeddings are allowed **only** inside the offline librarian for de-dup; never during run-time retrieval.
7. **Less code is better.** If a phase can ship without a new dependency or a new module, do that. No `utils/`, no `helpers/`. Follow the folder-is-responsibility rule from `HANDOFF.md` section "North star".
8. **No file over 500 lines.** Per `CLAUDE.md`. Split along the responsibility seam, not the line count.

---

## Physical layout

Skills live under a **user-scoped** directory (not the target repo, not this tool's source tree):

```
~/.claude-overnight/skills/
  index.sqlite                  ← librarian-owned; queried read-only by runs
  <repo-fingerprint>/
    canon/
      <skill-name>.md           ← promoted skills (frontmatter + body ≤ 15KB)
      <skill-name>/             ← optional: attached reference files (L2)
        references/*.md
    candidates/
      <timestamp>-<agent>.md    ← raw proposals from any agent
    quarantine/
      <skill-name>.md           ← librarian-demoted; kept for audit, not retrieved
  LIBRARIAN.md                  ← per-run diff of promotions/demotions
```

**Fingerprint** = SHA-256 of `git config --get remote.origin.url` (or repo root realpath if no remote), first 12 chars. Computed once per run and cached on the run state.

**Rationale.** Target repo stays clean. One global index allows cross-repo telemetry queries (e.g. "which skills earned their keep this month"). Per-fingerprint filtering prevents a Python repo from ever seeing a Node skill.

---

## Acceptance bar per phase

Every phase ships only if:

- `npm run build` passes.
- `npm test` passes (current: 160/160).
- No source file over 500 lines.
- Smoke tested against a real 1000-budget run using `scripts/e2e-smoke.mjs` or manual.
- The phase's own acceptance list (in its phase file) is fully checked.
- A new reader can open the new files and state each one's purpose from the filename alone.

---

## What gets saved and what doesn't

**Save as candidates** (any agent, any time):
- A non-obvious workflow that worked. ≥2 tool calls, or a recovery after error.
- A repo-specific quirk (build command, test runner flag, import path convention).
- A failure pattern worth avoiding.

**Do not save** (these rot fast):
- Task-specific state ("branch X was the one I was on").
- Anything derivable from `git log`, `README.md`, or `package.json`.
- Re-phrasings of existing canon skills.
- Single-tool-call observations.

**The librarian enforces this at promotion time.** Candidates that fail the filter are logged to `LIBRARIAN.md` as rejected, not silently dropped.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Skills accumulate and rot, degrading context | `last_used`, `wins/uses`, `cost_saved_usd` tracked per skill; auto-quarantine thresholds. See `phase-2-librarian.md#gc`. |
| L0 stub grows past budget | Structural pre-filter (fingerprint + language + toolset) runs before size cap; if still over, rank by `wins/uses` and truncate — never inject partial stubs. |
| Librarian itself bloats | Librarian reads only from filesystem + SQLite queries; it never has skill bodies in its own context. It's a subagent on the planner pattern. |
| Skill disagrees with current code | Librarian's PR gate; users own promotion. Quarantine is one flag flip, not a delete. |
| Index corruption | SQLite is file-based, safe to rm; `librarian --reindex` rebuilds from markdown source of truth. |

---

## Phase summary (one line each)

- **Phase 1 — Scribe.** Agents write candidates to disk. No retrieval, no injection. Measure candidate volume + rough quality by eye. 1 week.
- **Phase 2 — Librarian + index + L0 injection.** Librarian runs at end-of-wave, promotes / patches / quarantines, rebuilds index. Planner gets L0 stub on next run. Measure cost delta per run. 2 weeks.
- **Phase 3 — A/B waves.** Sibling branches run with/without candidate skill; verifier delta feeds telemetry. 1 week.
- **Phase 4 — Tool recipes.** Markdown recipes for commonly-rewritten helpers; never executable, always re-rendered by agent. 1 week.

Total runway to value: phase 1 + 2 shipped = retrieval loop closed. Phases 3 and 4 amplify.

---

## Start

Open [`phase-1-scribe.md`](./phase-1-scribe.md). Do not read the others.
