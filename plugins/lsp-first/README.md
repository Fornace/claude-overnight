# lsp-first

PreToolUse Grep blocker that redirects agents to LSP tools (cclsp / serena / any MCP LSP bridge) when the Grep pattern looks like a code symbol.

Language-agnostic — pattern-shape detection only, no TypeScript/Python/Go assumptions. Swap in whatever MCP LSP server you have wired globally.

## Why

Grep-heavy agents burn tokens scanning for symbols that the LSP already knows precisely. Blocking Grep on camelCase / PascalCase / dotted / snake_case symbols and suggesting `mcp__cclsp__find_references` / `find_workspace_symbols` instead cuts context waste substantially and gives more accurate results.

Inspired by [`nesaminua/claude-code-lsp-enforcement-kit`](https://github.com/nesaminua/claude-code-lsp-enforcement-kit).

## Install

Two options:

1. **Global plugin** — enable as a Claude Code plugin at user or project level. Agents spawned by `claude-overnight` inherit it automatically.
2. **Auto-inject into worktrees** — set `CLAUDE_OVERNIGHT_LSP_FIRST=1` before launching `claude-overnight`. Each agent worktree gets a `.claude/settings.local.json` that wires the hook in.

Either way, an LSP MCP server must also be configured — typically [`cclsp`](https://github.com/ktnyt/cclsp) or [`serena`](https://github.com/oraios/serena).

## Fail-safe

- The hook detects whether `cclsp` / `serena` appear in the user's Claude config. If neither is configured, Grep is allowed through — we never block an agent that has no LSP alternative.
- The worktree auto-inject performs the same check before writing the settings file.
- `CLAUDE_LSP_FIRST_FORCE=1` overrides the detection if you know your MCP is wired up elsewhere.
- Any hook error (bad JSON, unknown tool shape, etc.) exits 0 — a broken hook never stalls the agent.

## Installing an LSP server

We can't reliably install the per-language LSP stack for you — cclsp needs at least one language server available on PATH:

- TypeScript / JavaScript: `npm install -g typescript-language-server typescript`
- Python: `pipx install python-lsp-server` (or pyright)
- Go: `go install golang.org/x/tools/gopls@latest`
- Rust: `rustup component add rust-analyzer`

Then add cclsp via `claude mcp add cclsp -- npx -y @cclsp/cclsp` (or follow cclsp's setup wizard). If none of that is present, this plugin stays out of the way.
