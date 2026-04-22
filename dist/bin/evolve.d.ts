#!/usr/bin/env node
/**
 * `claude-overnight-evolve` — CLI for the prompt-evolution engine.
 *
 * Ships with the npm package (compiled to dist/bin/evolve.js). The MCP-browser
 * platform runs this binary inside a per-project `raw`-mode container via
 * `docker exec`. See docs/prompt-evolution-research.md.
 *
 * Examples:
 *   claude-overnight-evolve --prompt 10_planning/10-3_plan --eval-model claude-haiku-4-5 --generations 3
 *   claude-overnight-evolve --target mcp-browser --prompt-kind plan-supervision --eval-model kimi-k2-6
 *
 * Requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in env. When `--target
 * mcp-browser` is used the cwd must be the MCP-browser repo root (so
 * `platform/supervisor/gemini-client.ts` resolves), or pass the file via
 * `MCP_BROWSER_GEMINI_CLIENT`.
 */
export {};
