# Handoff — Prompt Evolution: promote + download

## What shipped

Three gaps in the self-evolution loop were closed:

1. **`promote` subcommand** (`src/bin/evolve.ts`, `src/bin/evolve-subcommands.ts`)
   - `claude-overnight-evolve promote <runId> [--variant <id>] [--into <block>]`
   - Writes a run's winning variant back into the source prompt file's `<!-- BLOCK -->` marker.
   - Seed variants auto-target their own block; `evo-*` mutants require `--into`.
   - Tested: promoted `tight` → `STANDARD` block, file still renders correctly via `renderPrompt`.

2. **`download` subcommand** (`src/bin/evolve.ts`, `src/bin/evolve-subcommands.ts`)
   - `claude-overnight-evolve download <runId> --base-url <url> [--token <token>] [--project <id>]`
   - Pulls a remote run (fornace or self-host) into `~/.claude-overnight/prompt-evolution/<runId>/`.
   - Fetches: `meta.json`, `report.md`, `best.md`, `matrix.jsonl`, `learning.jsonl`, and all `prompts/*.md` snapshots.
   - Parses `matrix.jsonl` to discover any prompt files the listing missed.

3. **Server-side file endpoints**
   - **Self-host** (`self-host/server.mjs`): added `GET /runs/:id/files` (recursive listing) and fixed `GET /runs/:id/files/:name` to support subdirectories (`prompts/default.md`).
   - **MCP-browser / fornace** (`../MCP-Browser/platform/api/prompt-evolution-files.ts`): added `GET /:id/prompt-evolution/:runId/files` and `GET /:id/prompt-evolution/:runId/files/*` with path-traversal guards.

4. **500-line cleanup**
   - Extracted evolve subcommands from `src/bin/evolve.ts`.
   - Extracted MCP-Browser env helpers and file endpoints from `platform/api/prompt-evolution.routes.ts`.

## Commit / deploy status

- `claude-overnight` committed and pushed: `443dfc5 feat(prompt-evolution): add download and promote commands`.
- `MCP-Browser` committed and pushed: `7175171 feat(prompt-evolution): expose run files for download`.
- fornace deployed from `/opt/browser-mcp` at `7175171`.
- `agent-platform` restarted and verified `active`.
- Deployed `/files` endpoints return auth (`401`) when unauthenticated, confirming the routes are live.

## Build status

- `npm run build` passes cleanly.
- `npm run platform:build` passes cleanly in MCP-Browser.
- `npm test` passes in claude-overnight.
- `dist/` is in sync with `src/`.

## Files changed

```
claude-overnight/
  src/bin/evolve.ts           (subcommand dispatch + help)
  src/bin/evolve-subcommands.ts  (promote + download + diff)
  src/prompts/load.ts         (+1 export — PROMPTS_ROOT)
  self-host/server.mjs        (+31 lines — listing + subdirectory fix)
  dist/                       (rebuilt)

MCP-Browser/
  platform/api/prompt-evolution.routes.ts  (register extracted helpers/routes)
  platform/api/prompt-evolution-env.ts     (extracted env helpers)
  platform/api/prompt-evolution-files.ts   (files endpoints)
```

## How to use

### Kick off a true multi-gen run on fornace

```bash
curl -X POST https://fornace.net/api/projects/<project-id>/prompt-evolution/enqueue \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "claude-overnight",
    "prompt": "10_planning/10-3_plan",
    "evalModel": "claude-haiku-4-5",
    "generations": 10,
    "population": 8,
    "plateau": 3,
    "reps": 3
  }'
```

### Download and audit

```bash
claude-overnight-evolve download <runId> \
  --base-url https://fornace.net \
  --token <token> \
  --project <project-id>

# Now diff, inspect matrix, etc.
claude-overnight-evolve diff <runIdA> <runIdB>
```

### Promote the winner

```bash
# Auto-detect best variant and target block
claude-overnight-evolve promote <runId>

# Or be explicit: promote an evo mutant into the TIGHT block
claude-overnight-evolve promote <runId> --variant evo-abc123 --into tight
```

## Open questions / next steps

- **Generations=1 mystery**: audited MCP-Browser frontend/client code and found no caller overriding `generations`; only the backend route references it and defaults to `10`. If historical runs show `generations=1`, it likely came from an external/direct API caller.
- **✓ DONE: Optional enhancement**: a `--watch` flag on `download` that polls until the run finishes and then auto-downloads.
- **✓ DONE: Optimal Model Mix**: Settled on `gemini-3.1-flash-lite-preview` for eval loops (insanely fast, very cheap, strict JSON discipline) and `gemini-3.1-pro-preview` for mutations (deep reasoning, understands prompt patterns). Added `npm run evolve:favorite` as a shortcut.
- **✓ DONE: Transport Patches**: Added full `generativelanguage.googleapis.com` OpenAI wrapper support in `transport.ts` and `mutator.ts` to accommodate the new optimal Google model mix.
- **✓ DONE: First 10-gen loop applied**: `run_moeuvadh_0bdj` found an optimal planning prompt strategy, beating the baseline by 9.3 percentage points. Reduced `STANDARD` and `LARGE` down to the highly specific, zero-ambiguity `TIGHT` variation. Promoted and pushed.
