# Playwright Parallel Usage

When running claude-overnight with parallel agents that use the Playwright MCP server, avoid lock conflicts and session cross-contamination.

## Isolation Levels

| Goal | Approach |
|---|---|
| Non-disruptive, no focus steal | Headless mode (default) |
| Several agents in parallel, no shared cookies | Headless + each MCP server: `--isolated` (or `isolated: true`) |
| Several agents, each with saved login | Headless + each MCP server: unique `userDataDir` or its own `--storage-state` file |
| Anti-bot interception (CAPTCHA, Cloudflare) | Fall back to headed mode only when necessary |

**Headless preferred by default.** Every headed browser launch becomes the foreground app on macOS, which is disruptive during long runs. Only fall back to headed when anti-bot detection (CAPTCHA, Cloudflare challenge, etc.) requires visible browser interaction.

## MCP Server Configuration

Add to your `settings.json` or `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "playwright-1": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest", "--isolated", "--headless"],
      "env": {}
    },
    "playwright-2": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest", "--isolated", "--headless"],
      "env": {}
    }
  }
}
```

For saved logins, give each server its own `userDataDir`:

```json
{
  "mcpServers": {
    "playwright-agent-a": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest", "--headless", "--userDataDir", "/tmp/pw-agent-a"],
      "env": {}
    },
    "playwright-agent-b": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest", "--headless", "--userDataDir", "/tmp/pw-agent-b"],
      "env": {}
    }
  }
}
```

## Context7 Documentation

For the latest Playwright API docs and patterns:

```bash
npx ctx7@latest library playwright "parallel browser instances isolation"
npx ctx7@latest docs <libraryId> "parallel browser instances"
```

**Note:** ctx7 requires authentication (`npx ctx7@latest login` or `CONTEXT7_API_KEY` env var). If unauthenticated, lookups will fail  -- agents should fall back to training data.
