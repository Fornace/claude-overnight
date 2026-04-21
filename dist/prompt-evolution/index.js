/**
 * Prompt evolution orchestration.
 *
 * Usage (programmatic):
 *   import { evolvePrompt } from "./prompt-evolution/index.js";
 *   await evolvePrompt({
 *     promptPath: "10_planning/10-3_plan",
 *     cases: PLAN_CASES,
 *     model: "claude-haiku-4-5",
 *     generations: 3,
 *   });
 *
 * The loop:
 *   1. Seed population from existing prompt variants (TIGHT, STANDARD, LARGE)
 *   2. Evaluate all variants against all cases → matrix
 *   3. Curate: keep elites + diverse variants
 *   4. Mutate worst-performing variants using failure traces
 *   5. Repeat
 */
import { renderPrompt } from "../prompts/load.js";
import { buildMatrix, renderVariant } from "./evaluator.js";
import { mutate } from "./mutator.js";
import { curate, formatMatrix } from "./curator.js";
export async function evolvePrompt(opts) {
    const log = opts.onLog ?? ((t) => process.stdout.write(t + "\n"));
    const generations = opts.generations ?? 3;
    const populationCap = opts.populationCap ?? 6;
    const mutateModel = opts.mutateModel ?? opts.evalModel;
    const canonGmean = opts.canonGmean ?? 0;
    // ── 1. Seed population from existing variants ──
    let population = seedPopulation(opts.promptPath);
    log(`Seeded ${population.length} variants from ${opts.promptPath}`);
    const learningLog = [];
    let bestOverall = null;
    for (let gen = 0; gen < generations; gen++) {
        log(`\n=== Generation ${gen + 1}/${generations} | Population: ${population.length} ===`);
        // ── 2. Evaluate ──
        const evalOpts = {
            model: opts.evalModel,
            baseUrl: opts.baseUrl,
            authToken: opts.authToken,
            concurrency: 4,
            onProgress: (done, total, caseName, variantId) => {
                log(`  [${done}/${total}] ${variantId.slice(0, 16)} → ${caseName}`);
            },
        };
        const matrix = await buildMatrix(population, opts.cases, evalOpts);
        log(formatMatrix(matrix, opts.cases.map((c) => c.name)));
        // Track best
        const genBest = matrix.reduce((a, b) => (a.gmean > b.gmean ? a : b));
        if (!bestOverall || genBest.gmean > bestOverall.gmean) {
            bestOverall = genBest;
        }
        // ── 3. Curate ──
        const curateOpts = {
            eliteCount: Math.max(2, Math.floor(populationCap * 0.4)),
            diversityCount: Math.max(1, Math.floor(populationCap * 0.3)),
            promoteThreshold: 0.02,
        };
        const decision = curate(matrix, canonGmean, curateOpts);
        log(`Curator: promoted=[${decision.promoted.join(", ")}] kept=[${decision.kept.join(", ")}] quarantined=[${decision.quarantined.join(", ")}]`);
        // ── 4. Build next population ──
        const keptRows = matrix.filter((r) => decision.kept.includes(r.variantId));
        let nextPop = keptRows.map((r) => ({
            id: r.variantId,
            promptPath: r.promptPath,
            generation: r.generation,
            text: r.text,
        }));
        // ── 5. Mutate to refill ──
        const targetSize = Math.min(populationCap, keptRows.length + 2);
        if (nextPop.length < targetSize && gen < generations - 1) {
            const mutantsNeeded = targetSize - nextPop.length;
            log(`Generating ${mutantsNeeded} mutant(s)...`);
            // Pick parents: worst-performing kept variants (they have the most room to improve)
            const sorted = [...keptRows].sort((a, b) => a.gmean - b.gmean);
            const parents = sorted.slice(0, mutantsNeeded);
            for (let i = 0; i < parents.length; i++) {
                const parent = parents[i];
                const failures = [...parent.results.values()]
                    .filter((r) => r.notes.length > 0 || gmean(r.scores) < 0.7)
                    .sort((a, b) => gmean(a.scores) - gmean(b.scores))
                    .slice(0, 3)
                    .map((r) => ({
                    caseName: r.caseName,
                    caseHash: r.caseHash,
                    rawOutput: r.rawOutput,
                    notes: r.notes,
                    scores: r.scores,
                }));
                const siblings = keptRows
                    .filter((r) => r.variantId !== parent.variantId)
                    .map((r) => r.text);
                const req = {
                    currentText: parent.text,
                    promptPath: opts.promptPath,
                    failures,
                    learningLog,
                    siblingTexts: siblings,
                };
                try {
                    const mutant = await mutate(req, {
                        model: mutateModel,
                        baseUrl: opts.baseUrl,
                        authToken: opts.authToken,
                    });
                    mutant.generation = gen + 1;
                    mutant.parentId = parent.variantId;
                    const prevGmean = parent.gmean;
                    nextPop.push({
                        id: mutant.variantId,
                        promptPath: opts.promptPath,
                        generation: mutant.generation,
                        text: mutant.text,
                    });
                    learningLog.push({
                        generation: gen,
                        mutationSummary: mutant.mutationSummary,
                        fitnessDelta: 0, // filled next gen
                        status: "neutral",
                    });
                    log(`  Mutant ${mutant.variantId} ← ${parent.variantId}: ${mutant.mutationSummary}`);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log(`  Mutant failed: ${msg.slice(0, 120)}`);
                }
            }
        }
        population = nextPop;
    }
    // Final evaluation of surviving population
    log(`\n=== Final evaluation ===`);
    const finalMatrix = await buildMatrix(population, opts.cases, {
        model: opts.evalModel,
        baseUrl: opts.baseUrl,
        authToken: opts.authToken,
        concurrency: 4,
    });
    log(formatMatrix(finalMatrix, opts.cases.map((c) => c.name)));
    const best = finalMatrix.reduce((a, b) => (a.gmean > b.gmean ? a : b));
    if (bestOverall && bestOverall.gmean > best.gmean) {
        // Return the historical best even if it didn't survive final cull
        return { bestVariant: bestOverall, allRows: finalMatrix, learningLog };
    }
    return { bestVariant: best, allRows: finalMatrix, learningLog };
}
// ── Helpers ──
function seedPopulation(promptPath) {
    const variants = [];
    // Always seed the default (no variant)
    try {
        variants.push({
            id: "default",
            promptPath,
            generation: 0,
            text: renderPrompt(promptPath, {}),
        });
    }
    catch { /* prompt may require variants */ }
    // Seed named variants if the prompt has <!-- @@@ --> markers
    const namedVariants = ["TIGHT", "STANDARD", "LARGE", "WRAP", "AMEND", "WAVE", "RUN", "FILE", "ALL", "POSTFAILED", "NOFILES"];
    for (const v of namedVariants) {
        try {
            const text = renderVariant(promptPath, v, {});
            variants.push({ id: v.toLowerCase(), promptPath, generation: 0, text });
        }
        catch { /* variant doesn't exist in this prompt */ }
    }
    return variants;
}
function gmean(scores) {
    const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
    const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
    return Math.pow(product, 1 / vals.length);
}
