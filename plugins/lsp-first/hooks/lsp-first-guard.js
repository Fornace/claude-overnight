#!/usr/bin/env node
'use strict';

// PreToolUse hook (matcher: Grep).
// When the pattern looks like a code symbol (camelCase / PascalCase / dotted /
// snake_case function), block the tool and tell the agent to use cclsp or any
// other MCP LSP bridge instead. Fails OPEN on any error so a broken hook never
// stalls the agent.
//
// SAFETY: if no LSP MCP server (cclsp / serena) is wired into the current
// Claude Code environment, the hook short-circuits and lets Grep through —
// we never block an agent that has no LSP alternative.

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try { run(); } catch { process.exit(0); }
});

function run() {
  let data;
  try { data = JSON.parse(raw); } catch { return process.exit(0); }
  if (data.tool_name !== 'Grep') return process.exit(0);

  // Fail-safe: no LSP MCP available ⇒ don't block Grep; agent has no alternative.
  if (!detectLspMcp()) return process.exit(0);

  const input = data.tool_input || {};
  const pattern = String(input.pattern ?? '').trim();
  const searchPath = String(input.path ?? '');
  const glob = String(input.glob ?? '');

  // Scope-outs: docs, configs, migrations, vendor — always fine to grep.
  if (/node_modules|\.claude[\\/]|docs?[\\/]|logs?[\\/]|supabase[\\/]migrations/i.test(searchPath)) return process.exit(0);
  if (/\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss)/i.test(glob)) return process.exit(0);
  if (pattern.length < 4) return process.exit(0);

  const symbols = pattern.split('|').map((s) => s.trim()).filter(Boolean).filter(isCodeSymbol);
  if (symbols.length === 0) return process.exit(0);

  const lspHints = symbols.map((s) => {
    const intent = /^[A-Z]/.test(s) ? 'workspace symbol / definition' : 'references';
    return `  ${s}  →  ${intent}\n    mcp__cclsp__find_${/^[A-Z]/.test(s) ? 'workspace_symbols' : 'references'}("${s}")`;
  }).join('\n');

  const reason = `LSP-FIRST: Pattern contains code symbol(s) [${symbols.join(', ')}]. Use LSP tools (cclsp / serena / any MCP LSP bridge) instead of Grep:\n${lspHints}`;
  process.stderr.write(`\n⛔ LSP-FIRST BLOCK\n${reason}\n\n`);
  // PreToolUse block contract: exit code 2 OR a JSON decision "block".
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(2);
}

/**
 * Look for a cclsp / serena MCP server in the user's Claude Code config.
 * Read-only, cheap, cached once per process. Returns true only when there's
 * actually something for the agent to redirect to.
 */
let _lspDetected;
function detectLspMcp() {
  if (_lspDetected !== undefined) return _lspDetected;
  const candidates = [
    join(homedir(), '.claude.json'),
    join(homedir(), '.config', 'claude', 'claude.json'),
    // Project-local
    join(process.cwd(), '.mcp.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      // Cheap substring check — no need to parse JSON. Either name landing
      // anywhere in the file means the user has an LSP MCP configured.
      if (/\b(cclsp|serena)\b/.test(text)) { _lspDetected = true; return true; }
    } catch {}
  }
  // Env override — allow users to force-enable even if config scan misses.
  if (/^(1|true|yes)$/i.test(process.env.CLAUDE_LSP_FIRST_FORCE ?? '')) {
    _lspDetected = true; return true;
  }
  _lspDetected = false;
  return false;
}

function isCodeSymbol(s) {
  if (s.length < 4) return false;
  if (/\s/.test(s)) return false;
  if (/[&?+[\]{}()\\^$*]/.test(s)) return false;

  // Allow-list: things that look symbol-y but are prose/markers/URLs/short words.
  const allow = [
    /^(TODO|FIXME|HACK|XXX|NOTE)/i,
    /^(console|import|require|from|export)\b/,
    /^\/\//, /^#/, /^\./, /^http/i, /^\d/, /^['"`]/,
    /^[A-Z_]{3,}$/,          // CONSTS
    /^[a-z]{1,8}$/,          // short lowercase words
    /^use (client|server)/,
  ];
  if (allow.some((rx) => rx.test(s))) return false;

  const isCamel = /^[a-z][a-zA-Z0-9]{3,}$/.test(s) && /[A-Z]/.test(s);
  const isPascal = /^[A-Z][a-zA-Z][a-zA-Z0-9]{2,}$/.test(s);
  const isDotted = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/i.test(s);
  const isSnake = /^[a-z]+(_[a-z]+){2,}$/.test(s) && s.length >= 9;
  return isCamel || isPascal || isDotted || isSnake;
}
