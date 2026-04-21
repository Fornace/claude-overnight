#!/usr/bin/env node
/**
 * CLI: evolve a prompt against benchmark cases.
 *
 * Examples:
 *   # Evolve a claude-overnight planner prompt
 *   node scripts/evolve-prompt.mjs --prompt 10_planning/10-3_plan --eval-model claude-haiku-4-5 --generations 3
 *
 *   # Evolve an MCP-browser supervision prompt
 *   node scripts/evolve-prompt.mjs --target mcp-browser --prompt-kind plan-supervision --eval-model kimi-k2-6 --generations 3
 *
 * Requires:
 *   - ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in env
 *   - ANTHROPIC_BASE_URL if using a proxy (optional)
 *   - For MCP-browser: the MCP-browser repo at ../MCP-browser
 *   - The project to be built (npm run build)
 */

import { evolvePrompt } from "../dist/prompt-evolution/index.js";
import { PLAN_CASES } from "../dist/prompt-evolution/fixtures/plan-cases.js";
import {
  scenariosToCases,
  PLANNING_SCENARIOS,
  REVIEW_SCENARIOS,
  SUPERVISION_SCENARIOS,
  STUCK_SCENARIOS,
  hydrateCases,
  extractPrompt,
} from "../dist/prompt-evolution/adapters/mcp-browser.js";

function help() {
  console.log(`Usage: node scripts/evolve-prompt.mjs [options]

Options:
  --target <name>         Target project: claude-overnight | mcp-browser (default: claude-overnight)
  --prompt <path>         Prompt file path (claude-overnight only)
  --prompt-kind <kind>    MCP-browser prompt kind: planning | review | evolution | goal-refinement | plan-supervision | simple-supervision | stuck-analysis
  --eval-model <model>    Fast model for evaluation (default: claude-haiku-4-5)
  --mutate-model <model>  Smarter model for mutation (defaults to eval-model)
  --generations <n>       Number of evolution generations (default: 10)
  --population <n>        Max population size (default: 8)
  --plateau <n>           Stop early if no improvement for N generations (default: 3)
  --cases <suite>         Benchmark suite: plan | mcp-planning | mcp-review | mcp-supervision | mcp-stuck (default: plan)
  --base-url <url>        API base URL override
  --auth-token <token>    Auth token override
`);
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) help();

  const opts = {
    target: "claude-overnight",
    prompt: "10_planning/10-3_plan",
    promptKind: "",
    evalModel: process.env.EVAL_MODEL ?? "claude-haiku-4-5",
    mutateModel: process.env.MUTATE_MODEL,
    generations: 10,
    population: 8,
    plateau: 3,
    cases: "",
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--target": opts.target = args[++i]; break;
      case "--prompt": opts.prompt = args[++i]; break;
      case "--prompt-kind": opts.promptKind = args[++i]; break;
      case "--eval-model": opts.evalModel = args[++i]; break;
      case "--mutate-model": opts.mutateModel = args[++i]; break;
      case "--generations": opts.generations = parseInt(args[++i], 10); break;
      case "--population": opts.population = parseInt(args[++i], 10); break;
      case "--plateau": opts.plateau = parseInt(args[++i], 10); break;
      case "--cases": opts.cases = args[++i]; break;
      case "--base-url": opts.baseUrl = args[++i]; break;
      case "--auth-token": opts.authToken = args[++i]; break;
    }
  }

  // Auto-select cases for MCP-browser
  if (opts.target === "mcp-browser" && !opts.cases) {
    const kind = opts.promptKind || "planning";
    opts.cases = `mcp-${kind}`;
  }
  if (!opts.cases) opts.cases = "plan";

  return opts;
}

async function main() {
  const opts = parseArgs();

  let cases;
  let promptPath = opts.prompt;
  let seedText;
  let kind;

  if (opts.target === "mcp-browser") {
    kind = /** @type {McpPromptKind} */ (opts.promptKind || "planning");
    const scenarioMap = {
      planning: PLANNING_SCENARIOS,
      review: REVIEW_SCENARIOS,
      evolution: [],
      "goal-refinement": [],
      "plan-supervision": SUPERVISION_SCENARIOS,
      "simple-supervision": SUPERVISION_SCENARIOS,
      "stuck-analysis": STUCK_SCENARIOS,
    };
    const scenarios = scenarioMap[kind] || [];
    cases = hydrateCases(scenariosToCases(kind, scenarios));
    promptPath = `mcp-browser/${kind}`;
    seedText = extractPrompt(kind);
  } else {
    switch (opts.cases) {
      case "plan":
        cases = PLAN_CASES;
        break;
      default:
        console.error(`Unknown case suite: ${opts.cases}`);
        process.exit(1);
    }
  }

  console.log(`Evolution config:`);
  console.log(`  target:      ${opts.target}`);
  console.log(`  prompt:      ${promptPath}`);
  console.log(`  evalModel:   ${opts.evalModel}`);
  console.log(`  mutateModel: ${opts.mutateModel ?? opts.evalModel}`);
  console.log(`  generations: ${opts.generations}`);
  console.log(`  population:  ${opts.population}`);
  console.log(`  plateau:     ${opts.plateau}`);
  console.log(`  cases:       ${cases.length} (${opts.cases})`);
  console.log("");

  const result = await evolvePrompt({
    promptPath,
    cases,
    evalModel: opts.evalModel,
    mutateModel: opts.mutateModel,
    generations: opts.generations,
    populationCap: opts.population,
    plateauGenerations: opts.plateau,
    baseUrl: opts.baseUrl,
    authToken: opts.authToken,
    seedText,
    target: opts.target,
    onLog: (text) => console.log(text),
  });

  console.log("\n=== BEST VARIANT ===");
  console.log(`id:        ${result.bestVariant.variantId}`);
  console.log(`generation: ${result.bestVariant.generation}`);
  console.log(`gmean:      ${(result.bestVariant.gmean * 100).toFixed(1)}%`);
  console.log(`parse:      ${(result.bestVariant.aggregate.parse * 100).toFixed(1)}%`);
  console.log(`schema:     ${(result.bestVariant.aggregate.schema * 100).toFixed(1)}%`);
  console.log(`content:    ${(result.bestVariant.aggregate.content * 100).toFixed(1)}%`);
  console.log(`cost:       ${(result.bestVariant.aggregate.costEfficiency * 100).toFixed(1)}%`);
  console.log(`speed:      ${(result.bestVariant.aggregate.speed * 100).toFixed(1)}%`);
  console.log("\n--- Prompt text ---");
  console.log(result.bestVariant.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
