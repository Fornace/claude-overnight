# Phase 1 — Scribe

**Goal.** Any agent, anywhere in the swarm, can append a candidate skill to disk without blocking, without retrieval, without a librarian yet. This phase produces *data* — we want to see what agents propose before we build the machinery around it.

**Time budget.** ~1 week, one session per day.

**Ship criterion.** One real overnight run produces a non-zero number of candidates, and none crash the run.

---

## Open these only when you need them

- Schemas: [`schemas.md`](./schemas.md) — section 1 (candidate) and section 7 (size guards).
- File map: [`integration-map.md`](./integration-map.md) — "Phase 1 — scribe wiring" row and "Files to create".

Do not read `phase-2-librarian.md` or later yet.

---

## Scope

**In scope.**

1. `src/skills/paths.ts` — compute user-scoped paths.
2. `src/skills/scribe.ts` — `writeCandidate()` with size cap, never throws.
3. Wire it into three places:
   - `src/swarm/agent-run.ts` — wave agent completion
   - `src/planner/query.ts` — planner / steerer / verifier returns
   - `src/run/wave-loop.ts` — end-of-wave summary candidate
4. A deliberate opt-in: agents only propose candidates when the system prompt explicitly tells them they can. No silent "every agent writes on every call." The opt-in lives in the planner and worker system prompts as a short paragraph with a concrete example.
5. `src/__tests__/scribe.test.ts` — unit tests for size cap, path shape, roundtrip.

**Out of scope.**

- Any retrieval. No reading candidates back.
- Any librarian. Candidates pile up; that's fine.
- Any SQLite. No index yet.
- Any prompt injection. Agents don't see skills yet.
- Any tool registration. `skill_read` / `skill_search` are phase 2.

---

## Implementation order

1. **`src/skills/paths.ts`** — pure functions. No I/O except `os.homedir()`.

   Exports:
   ```ts
   skillsRoot(): string                                 // ~/.claude-overnight/skills
   fingerprintDir(fp: string): string                   // <root>/<fp>
   candidatesDir(fp: string): string                    // <root>/<fp>/candidates
   canonDir(fp: string): string                         // <root>/<fp>/canon      (stub for phase 2)
   quarantineDir(fp: string): string                    // <root>/<fp>/quarantine (stub for phase 2)
   indexPath(): string                                  // <root>/index.sqlite    (stub for phase 2)
   ```

   `mkdirSync(..., { recursive: true })` at resolution time. Safe to call repeatedly.

2. **`src/skills/scribe.ts`** — `writeCandidate(input): void`.

   Input shape (see schemas.md §1):
   ```ts
   interface CandidateInput {
     kind: "skill" | "tool-recipe" | "heuristic";
     proposedBy: string;        // agent id / role
     wave: number;
     runId: string;
     fingerprint: string;       // computed in phase 1 too; see below
     trigger: string;           // ≤ 120 chars
     body: string;              // markdown; the function prepends frontmatter
   }
   ```

   Behavior:
   - Prepend the YAML frontmatter exactly as in schemas.md §1.
   - Enforce body ≤ 5KB. If oversize, truncate the body and append a `> [truncated at 5KB by scribe]` note.
   - Write atomically: write to `<path>.tmp` then `rename()`.
   - Filename: `<ISO-timestamp-with-hyphens>-<sanitized-proposedBy>.md`.
   - Back-pressure: if `candidatesDir` holds > 50 files, return silently without writing. Log a debug line. Phase 2's librarian drains this queue.
   - Never throws. All `fs` errors caught and logged to the debug sink.

3. **`computeRepoFingerprint` — minimal version in phase 1.** Yes, this file is called out as phase 2 in the map; we need a cut-down version now because the scribe needs it. Put it inline in `scribe.ts` as a private helper for phase 1, move it to `src/core/fingerprint.ts` in phase 2.

   Phase-1 fingerprint logic:
   ```ts
   // Minimal; swap out in phase 2 for the proper one in src/core/fingerprint.ts.
   function phase1Fingerprint(cwd: string): string {
     try {
       const remote = execSync("git config --get remote.origin.url", {
         cwd, stdio: ["ignore", "pipe", "ignore"]
       }).toString().trim();
       if (remote) return sha256(remote).slice(0, 12);
     } catch {}
     return sha256(realpathSync(cwd)).slice(0, 12);
   }
   ```

4. **Wire into agent completion (`src/swarm/agent-run.ts`).**

   Find the return path of `runAgent()` (grep `return { outcome`). Just before returning a successful result, call:

   ```ts
   if (ctx.allowSkillProposals && result.skillProposal) {
     writeCandidate({
       kind: "skill",
       proposedBy: ctx.agentId,
       wave: ctx.waveNum,
       runId: ctx.runId,
       fingerprint: ctx.fingerprint,
       trigger: result.skillProposal.trigger,
       body: result.skillProposal.body,
     });
   }
   ```

   **Where does `result.skillProposal` come from?** The agent emits it as a final structured output when it recognized a candidate worth saving. The system prompt (see below) tells the agent the exact shape. You do not add any post-parsing or regex matching — follow the global rule "do not try to replace the model on parsing." Use the SDK's native JSON-output mode if you need a strict shape; otherwise a short markdown convention (`### SKILL CANDIDATE` section) plus a tiny slicer is acceptable.

5. **Wire into planner / steerer / verifier (`src/planner/query.ts`).**

   Same pattern. One call at each of the function's success exits.

6. **Wire into wave-loop (`src/run/wave-loop.ts`).**

   After wave settles, before steering, emit one `kind:"heuristic"` candidate summarizing the wave:

   ```
   trigger: "wave-<n> <outcome-short>"
   body: objective + files-changed + verifier result
   ```

   Oneliner body; do not exceed 800 chars. This is provenance, not a real skill.

7. **System-prompt opt-in.**

   Add a short paragraph to the worker / planner / verifier system prompts. Keep it **minimal** — per the global AI-API-minimalism rule:

   ```
   If, while doing this task, you encounter a non-obvious workflow or
   repo-specific quirk that would save a future agent time, emit a block
   like this at the very end of your response:

   ### SKILL CANDIDATE
   trigger: <one sentence>
   body: <markdown, 2-5 short sections: when to apply, steps, caveats>

   Only emit this when the signal is strong. Otherwise omit.
   ```

   That's the whole prompt. Do not list what "non-obvious" means; do not enumerate categories. The model decides.

8. **Tests — `src/__tests__/scribe.test.ts`.**

   - Size cap: input body of 10 KB → file ≤ 5 KB + frontmatter + truncation note.
   - Filename shape: ISO timestamp, sanitized agent id.
   - Back-pressure: 51st write at capacity returns silently, no file created.
   - Roundtrip: YAML frontmatter parses back to input values.
   - No throw on `EACCES` — mock `fs.writeFileSync` to reject; assert return is void.

---

## Wave-loop instrumentation

Add to the existing end-of-wave log line (search `waveHistory.push`):

```
scribe: candidates=<count-this-wave>, queue=<total-in-dir>, drops=<backpressure-count>
```

This is the observability signal you watch during the first few real runs.

---

## Smoke test — before calling phase 1 done

1. `npm run build && npm test`.
2. Run `scripts/e2e-smoke.mjs` — must still pass in the same time as before (~10–14s). Scribe writes should not add measurable overhead.
3. Kick off a real 200-budget overnight run on a small target repo. After it ends:
   - `ls ~/.claude-overnight/skills/<fp>/candidates/ | wc -l` → some non-zero number, no more than the wave count × ~3 roles × ~1 avg.
   - Spot-read 5 random candidates. Do they describe something that *would* be worth recalling? If the answer is "no" to most, the system prompt is too permissive — tighten the "strong signal" language and retry.
4. `git status` on the target repo — clean. Scribe must not have written anywhere into it.

---

## Acceptance checklist (copy this into your commit message)

- [ ] `src/skills/paths.ts` exists, ≤ 60 lines, pure.
- [ ] `src/skills/scribe.ts` exists, ≤ 100 lines, never throws.
- [ ] `RunState.repoFingerprint` populated at run start.
- [ ] Three call sites wired: `agent-run.ts`, `query.ts`, `wave-loop.ts`.
- [ ] System-prompt opt-in added to worker / planner / verifier prompts.
- [ ] `src/__tests__/scribe.test.ts` passes with size cap / filename / back-pressure / roundtrip / no-throw cases.
- [ ] `npm run build && npm test` green.
- [ ] Real run produces candidates; zero scribe errors in debug log.
- [ ] No file over 500 lines changed or introduced.
- [ ] Target repo working tree untouched after a run.

---

## Stop signals — write to HANDOFF.md and stop

- You catch yourself post-parsing the agent's output with regex beyond `### SKILL CANDIDATE` slicing. Stop — revisit the system prompt or use the SDK's structured output.
- Scribe writes start throwing anywhere you can see them. Stop — never-throw is the contract.
- Candidates are all garbage ("ran tsc", "saw a file"). Stop — the opt-in prompt is too permissive. Tighten and re-smoke.
- Scribe becomes a new folder with > 3 files. Stop — merge back; this phase is 2 files.

---

## Hand-off to phase 2

When acceptance is green, the repo has:

- A queue of candidate md files per fingerprint.
- Zero retrieval.
- Zero model awareness of past skills.

That is the correct handoff. Phase 2 reads from that queue. Open [`phase-2-librarian.md`](./phase-2-librarian.md).
