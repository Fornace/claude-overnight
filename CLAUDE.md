# Project Rules

## No File Over 500 Lines

No source file should exceed 500 lines. Before adding code to a large file, split it first. Extract cohesive chunks into separate modules. Every task starts with: "Can I delete something instead?"

## Less Code Is Better

Prefer deleting 50 lines and adding 10 over adding 30 on top. Don't patch on top — fix by removing and simplifying.

## Relationship with fornace.net

claude-overnight is **not** a fornace client — it's a local CLI that
runs agents in git worktrees. It uses `ANTHROPIC_API_KEY` /
`ANTHROPIC_BASE_URL` directly, never an `fnc_…` token.

fornace consumes **this** package server-side: the platform route
`POST /api/projects/:id/prompt-evolution/enqueue` shells out to
`claude-overnight-evolve` inside a sandbox container. Design notes:
[`docs/prompt-evolution-research.md`](docs/prompt-evolution-research.md).

Full fornace service inventory (for reference if you need to reason
about that integration):
[`../MCP-Browser/docs/integration.md`](../MCP-Browser/docs/integration.md).

## Running Prompt Evolution

To evolve a prompt against a benchmark suite, we use a Darwinian loop.
The optimal models are:
- `--eval-model gemini-3.1-flash-lite-preview` (Blisteringly fast, cheap, perfect JSON schema discipline).
- `--mutate-model gemini-3.1-pro-preview` (Deep reasoning, structural rewriting).

**Run locally:**
```bash
# Uses the preferred model mix defined in package.json
npm run evolve:favorite
```

**Run remote (on fornace.net):**
We have a massive multi-day optimization suite covering the three core brains (`10-3_plan`, `30-1_steer`, `00-1_coach`).
1. Launch it: `./scripts/evolve-all-prompts.sh <PROJECT_ID> <FNC_TOKEN> <GOOGLE_API_KEY>`
2. Monitor it: `claude-overnight-evolve download <runId> --base-url https://fornace.net --token <FNC_TOKEN> --project <PROJECT_ID> --watch`
3. Promote winner: `claude-overnight-evolve promote <runId>`
