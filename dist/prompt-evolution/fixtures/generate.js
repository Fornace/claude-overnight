/**
 * LLM-backed benchmark case generator.
 *
 * 10 synthetic cases isn't enough for statistical significance below the
 * 10pp effect-size range — independent sample count is the binding
 * constraint. This module closes that gap by asking an LLM to produce
 * a large, diverse pool of realistic objectives across budget tiers.
 *
 * Generated cases are cached to
 *   $PROMPT_EVOLUTION_STORE/_generated-cases.json
 * so successive runs share the pool (deduplication is hash-based across
 * objective text, not semantic — good enough for our scale).
 *
 * The LLM call is ONE request that returns the full batch (typically
 * ~$0.01-0.05 on Haiku for 50 cases). No recurring cost after the cache
 * is primed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { defaultCallModel, attemptJsonParse } from "../transport.js";
const DEFAULT_CACHE = join(homedir(), ".claude-overnight", "prompt-evolution", "_generated-cases.json");
/**
 * Produce enough generated cases to hit `targetCount`, reading cache first
 * and only calling the LLM if we need more. Returns the full pool (cached
 * plus newly generated), all deduped against `existing`.
 */
export async function generateCases(opts) {
    const cachePath = opts.cachePath ?? DEFAULT_CACHE;
    const existingSigs = new Set((opts.existing ?? []).map((c) => signatureOf(String(c.vars.objective))));
    // Start with whatever's cached.
    let cached = readCache(cachePath);
    cached = cached.filter((c) => !existingSigs.has(signatureOf(String(c.vars.objective))));
    if (cached.length >= opts.targetCount)
        return cached.slice(0, opts.targetCount);
    // How many new ones we need. Over-generate by 20% to absorb dedup loss.
    const needed = opts.targetCount - cached.length;
    const askFor = Math.ceil(needed * 1.2);
    const prompt = buildGeneratorPrompt(askFor);
    const callOpts = {
        model: opts.model,
        baseUrl: opts.baseUrl,
        authToken: opts.authToken,
        maxTokens: Math.max(4096, askFor * 120),
        timeoutMs: 120_000,
    };
    const { raw } = await defaultCallModel(prompt, undefined, callOpts);
    const parsed = attemptJsonParse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed?.cases;
    if (!Array.isArray(items)) {
        throw new Error(`Generator returned non-array response (${raw.slice(0, 200)})`);
    }
    const newCases = [];
    const seen = new Set([
        ...existingSigs,
        ...cached.map((c) => signatureOf(String(c.vars.objective))),
    ]);
    for (const it of items) {
        const parsed = parseGenerated(it);
        if (!parsed)
            continue;
        const sig = signatureOf(parsed.objective);
        if (seen.has(sig))
            continue;
        seen.add(sig);
        newCases.push(toCase(parsed, opts.promptPath));
    }
    const combined = cached.concat(newCases);
    writeCache(cachePath, combined);
    return combined.slice(0, opts.targetCount);
}
function buildGeneratorPrompt(count) {
    return `You are generating benchmark test cases for a planner prompt evaluation.

Produce **exactly ${count}** distinct, realistic software-engineering objectives.
A developer would actually ask a coding agent to do each one. Be concrete.
Cover all three budget tiers roughly equally:

- **TIGHT** (budget 3-5): bugfix, typo, one-function change, single-file tweak
- **STANDARD** (budget 8-14): feature add, audit, refactor of one subsystem, test suite for one module
- **LARGE** (budget 25-40): multi-area refactor, new subsystem, cross-cutting concern

Diversity rules (enforce these):
- Include some ambiguously-worded objectives (planner must ask or split)
- Include some that mention fictional-but-plausible file paths and function names
- Include some where work might already be partially done
- Spread across frontend, backend, infra, data, tests, docs
- NO duplicates — each objective must target a different problem

Output a raw JSON array (no markdown fences, no preamble, no trailing prose):

[{"tier":"TIGHT","objective":"Fix the off-by-one in src/paginate.ts line 42","budget":4},
 {"tier":"STANDARD","objective":"Audit all API routes for input validation and fix issues","budget":10},
 {"tier":"LARGE","objective":"Migrate the queue subsystem from Redis to Kafka with backfill","budget":32},
 ...]`;
}
function parseGenerated(raw) {
    if (typeof raw !== "object" || raw == null)
        return null;
    const obj = raw;
    const tier = obj.tier;
    const objective = obj.objective;
    const budget = obj.budget;
    if (tier !== "TIGHT" && tier !== "STANDARD" && tier !== "LARGE")
        return null;
    if (typeof objective !== "string" || objective.length < 10)
        return null;
    if (typeof budget !== "number" || budget < 1 || budget > 100)
        return null;
    return { tier, objective: objective.trim(), budget };
}
function toCase(raw, promptPath) {
    const c = {
        name: `gen:${raw.tier.toLowerCase()}:${signatureOf(raw.objective).slice(0, 6)}`,
        hash: "",
        promptPath,
        variant: raw.tier,
        vars: {
            objective: raw.objective,
            budget: raw.budget,
            concurrency: Math.max(2, Math.min(8, Math.ceil(raw.budget / 3))),
            contextConstraintNote: "Context budget: use the claude-sonnet-4-6 model's context window efficiently.",
        },
        criteria: {
            independentTasks: true,
            specificTasks: raw.tier === "TIGHT",
            requiredJsonFields: ["tasks"],
        },
    };
    c.hash = hashCase(c);
    return c;
}
/** Stable first-100-chars signature — cheap dedup without semantic embedding. */
function signatureOf(objective) {
    const normalized = objective.toLowerCase().replace(/\s+/g, " ").slice(0, 100);
    let h = 0;
    for (let i = 0; i < normalized.length; i++) {
        h = ((h << 5) - h + normalized.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}
function hashCase(c) {
    const key = `${c.promptPath}:${c.variant ?? "default"}:${JSON.stringify(c.vars)}`;
    let h = 0;
    for (let i = 0; i < key.length; i++)
        h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36).slice(0, 8);
}
function readCache(path) {
    if (!existsSync(path))
        return [];
    try {
        const arr = JSON.parse(readFileSync(path, "utf-8"));
        // Re-hash in case schema changed
        for (const c of arr)
            c.hash = hashCase(c);
        return arr;
    }
    catch {
        return [];
    }
}
function writeCache(path, cases) {
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(cases, null, 2));
}
