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
