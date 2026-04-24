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
import { evolvePrompt } from "../prompt-evolution/index.js";
import { PLAN_CASES } from "../prompt-evolution/fixtures/plan-cases.js";
import { harvestRealCases } from "../prompt-evolution/fixtures/harvest.js";
import { scenariosToCases, PLANNING_SCENARIOS, REVIEW_SCENARIOS, SUPERVISION_SCENARIOS, STUCK_SCENARIOS, hydrateCases, extractPrompt, } from "../prompt-evolution/adapters/mcp-browser.js";
function help() {
    process.stdout.write(`Usage: claude-overnight-evolve [options]

Options:
  --target <name>         claude-overnight | mcp-browser (default: claude-overnight)
  --prompt <path>         Prompt file path (claude-overnight)
  --prompt-kind <kind>    MCP-browser prompt kind: planning | review | evolution |
                          goal-refinement | plan-supervision | simple-supervision | stuck-analysis
  --eval-model <model>    Fast model for evaluation (default: claude-haiku-4-5)
  --eval-models <list>    Comma-separated list to run cross-model (overrides --eval-model)
  --mutate-model <model>  Smarter model for mutation (defaults to eval-model)
  --generations <n>       Number of evolution generations (default: 10)
  --population <n>        Max population size (default: 8)
  --plateau <n>           Stop early if no improvement for N generations (default: 3)
  --reps <n>              Repetitions per (variant, case, model) for noise floor (default: 1)
  --judge                 Use llm-judge for content scoring (costs extra API calls)
  --judge-model <model>   Model to use for the judge (default: same as eval-model)
  --judge-top-n <n>       Judge only the top-N variants per generation (default: 4)
  --cases <suite>         Benchmark suite: plan | mcp-planning | mcp-review |
                          mcp-supervision | mcp-stuck (default: plan)
  --harvest               Append cases harvested from <cwd>/.claude-overnight/runs/*
  --harvest-limit <n>     Max harvested cases (default: 10)
  --base-url <url>        API base URL override
  --auth-token <token>    Auth token override
  --run-id <id>           Preset run id (default: auto-generated)
`);
    process.exit(0);
}
function parseArgs() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h"))
        help();
    const opts = {
        target: "claude-overnight",
        prompt: "10_planning/10-3_plan",
        promptKind: "",
        evalModel: process.env.EVAL_MODEL ?? "claude-haiku-4-5",
        mutateModel: process.env.MUTATE_MODEL,
        generations: 10,
        population: 8,
        plateau: 3,
        reps: 1,
        useJudge: false,
        judgeTopN: 4,
        cases: "",
        harvest: false,
        harvestLimit: 10,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
    };
    for (let i = 0; i < args.length; i++) {
        const v = args[i + 1];
        switch (args[i]) {
            case "--target":
                opts.target = v;
                i++;
                break;
            case "--prompt":
                opts.prompt = v;
                i++;
                break;
            case "--prompt-kind":
                opts.promptKind = v;
                i++;
                break;
            case "--eval-model":
                opts.evalModel = v;
                i++;
                break;
            case "--eval-models":
                opts.evalModels = v.split(",").map((s) => s.trim()).filter(Boolean);
                i++;
                break;
            case "--mutate-model":
                opts.mutateModel = v;
                i++;
                break;
            case "--generations":
                opts.generations = parseInt(v, 10);
                i++;
                break;
            case "--population":
                opts.population = parseInt(v, 10);
                i++;
                break;
            case "--plateau":
                opts.plateau = parseInt(v, 10);
                i++;
                break;
            case "--reps":
                opts.reps = parseInt(v, 10);
                i++;
                break;
            case "--judge":
                opts.useJudge = true;
                break;
            case "--judge-model":
                opts.judgeModel = v;
                i++;
                break;
            case "--judge-top-n":
                opts.judgeTopN = parseInt(v, 10);
                i++;
                break;
            case "--cases":
                opts.cases = v;
                i++;
                break;
            case "--harvest":
                opts.harvest = true;
                break;
            case "--harvest-limit":
                opts.harvestLimit = parseInt(v, 10);
                i++;
                break;
            case "--base-url":
                opts.baseUrl = v;
                i++;
                break;
            case "--auth-token":
                opts.authToken = v;
                i++;
                break;
            case "--run-id":
                opts.runId = v;
                i++;
                break;
        }
    }
    if (opts.target === "mcp-browser" && !opts.cases) {
        opts.cases = `mcp-${opts.promptKind || "planning"}`;
    }
    if (!opts.cases)
        opts.cases = "plan";
    return opts;
}
async function main() {
    const opts = parseArgs();
    let cases;
    let promptPath = opts.prompt;
    let seedText;
    if (opts.target === "mcp-browser") {
        const kind = (opts.promptKind || "planning");
        const scenarioMap = {
            planning: PLANNING_SCENARIOS,
            review: REVIEW_SCENARIOS,
            evolution: [],
            "goal-refinement": [],
            "plan-supervision": SUPERVISION_SCENARIOS,
            "simple-supervision": SUPERVISION_SCENARIOS,
            "stuck-analysis": STUCK_SCENARIOS,
        };
        cases = hydrateCases(scenariosToCases(kind, scenarioMap[kind]));
        promptPath = `mcp-browser/${kind}`;
        seedText = extractPrompt(kind);
    }
    else {
        if (opts.cases === "plan")
            cases = [...PLAN_CASES];
        else
            throw new Error(`Unknown case suite: ${opts.cases}`);
        if (opts.harvest) {
            const harvested = harvestRealCases({
                cwd: process.cwd(),
                promptPath,
                limit: opts.harvestLimit,
            });
            if (harvested.length === 0) {
                console.log(`  (harvest: no runs found under <cwd>/.claude-overnight/runs)`);
            }
            else {
                console.log(`  (harvest: +${harvested.length} real objectives)`);
                cases = cases.concat(harvested);
            }
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
        evalModels: opts.evalModels,
        mutateModel: opts.mutateModel,
        generations: opts.generations,
        populationCap: opts.population,
        plateauGenerations: opts.plateau,
        repetitions: opts.reps > 1 ? opts.reps : undefined,
        judge: opts.useJudge
            ? {
                model: opts.judgeModel ?? opts.evalModel,
                baseUrl: opts.baseUrl,
                authToken: opts.authToken,
                topN: opts.judgeTopN,
            }
            : undefined,
        baseUrl: opts.baseUrl,
        authToken: opts.authToken,
        seedText,
        target: opts.target,
        runId: opts.runId,
        onLog: (text) => console.log(text),
    });
    console.log("\n=== BEST VARIANT ===");
    console.log(`id:         ${result.bestVariant.variantId}`);
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
