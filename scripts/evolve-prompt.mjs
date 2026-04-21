#!/usr/bin/env node
/**
 * CLI: evolve a prompt against benchmark cases.
 *
 * Examples:
 *   node scripts/evolve-prompt.mjs --prompt 10_planning/10-3_plan --model claude-haiku-4-5 --generations 3
 *   node scripts/evolve-prompt.mjs --prompt 10_planning/10-3_plan --eval-model claude-haiku-4-5 --mutate-model claude-sonnet-4-5
 *
 * Requires:
 *   - ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in env
 *   - ANTHROPIC_BASE_URL if using a proxy (optional)
 *   - The project to be built (npm run build)
 */

import { evolvePrompt } from "../dist/prompt-evolution/index.js";
import { PLAN_CASES } from "../dist/prompt-evolution/fixtures/plan-cases.js";

function help() {
  console.log(`Usage: node scripts/evolve-prompt.mjs [options]

Options:
  --prompt <path>         Prompt file path (default: 10_planning/10-3_plan)
  --eval-model <model>    Fast model for evaluation (default: claude-haiku-4-5)
  --mutate-model <model>  Smarter model for mutation (defaults to eval-model)
  --generations <n>       Number of evolution generations (default: 3)
  --population <n>        Max population size (default: 6)
  --cases <suite>         Benchmark suite: plan (default: plan)
  --base-url <url>        API base URL override
  --auth-token <token>    Auth token override
`);
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) help();

  const opts = {
    prompt: "10_planning/10-3_plan",
    evalModel: process.env.EVAL_MODEL ?? "claude-haiku-4-5",
    mutateModel: process.env.MUTATE_MODEL,
    generations: 3,
    population: 6,
    cases: "plan",
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--prompt": opts.prompt = args[++i]; break;
      case "--eval-model": opts.evalModel = args[++i]; break;
      case "--mutate-model": opts.mutateModel = args[++i]; break;
      case "--generations": opts.generations = parseInt(args[++i], 10); break;
      case "--population": opts.population = parseInt(args[++i], 10); break;
      case "--cases": opts.cases = args[++i]; break;
      case "--base-url": opts.baseUrl = args[++i]; break;
      case "--auth-token": opts.authToken = args[++i]; break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  let cases;
  switch (opts.cases) {
    case "plan":
      cases = PLAN_CASES;
      break;
    default:
      console.error(`Unknown case suite: ${opts.cases}`);
      process.exit(1);
  }

  console.log(`Evolution config:`);
  console.log(`  prompt:      ${opts.prompt}`);
  console.log(`  evalModel:   ${opts.evalModel}`);
  console.log(`  mutateModel: ${opts.mutateModel ?? opts.evalModel}`);
  console.log(`  generations: ${opts.generations}`);
  console.log(`  population:  ${opts.population}`);
  console.log(`  cases:       ${cases.length} (${opts.cases})`);
  console.log("");

  const result = await evolvePrompt({
    promptPath: opts.prompt,
    cases,
    evalModel: opts.evalModel,
    mutateModel: opts.mutateModel,
    generations: opts.generations,
    populationCap: opts.population,
    baseUrl: opts.baseUrl,
    authToken: opts.authToken,
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
