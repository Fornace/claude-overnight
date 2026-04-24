/**
 * Evaluation matrix runner.
 *
 * rows    = variants
 * columns = cases (optionally × models)
 * cells   = EvaluationResult with multi-dimensional scores
 *
 * Repetitions (N) give us a noise floor: the same (variant, case) is run N
 * times and results aggregate to mean + stddev. Without this we can't tell
 * whether 56.7 vs 37.4 is signal or variance.
 *
 * Multi-model runs (models[].length > 1) give us cross-model stddev: a
 * prompt that only works on one generator is fragile.
 *
 * All HTTP calls go through `transport.callModel` so tests can inject a
 * deterministic mock (see prompt-evolution-discrimination.test.ts).
 */
import { renderPrompt } from "../prompts/load.js";
import { scoreOutput, gmean, aggregateReps, bootstrapCI, kendallTau } from "./scorer.js";
import { defaultCallModel, attemptJsonParse, } from "./transport.js";
import { batchCallModel, detectBatchProvider, } from "./transport-batch.js";
import { saveBatchState, loadBatchState, markBatchFinished } from "./persistence.js";
import { averageDimensions } from "./evaluator-utils.js";
import { runJudge } from "./evaluator-judge.js";
export async function buildMatrix(variants, cases, opts) {
    const models = opts.models && opts.models.length > 0 ? opts.models : [opts.model];
    const reps = Math.max(1, opts.repetitions ?? 1);
    const concurrency = opts.concurrency ?? 8;
    const transport = opts.callModel ?? defaultCallModel;
    // Build the full job list: (variant × case × model × rep).
    const jobs = [];
    for (const v of variants) {
        for (const c of cases) {
            for (const model of models) {
                for (let r = 0; r < reps; r++) {
                    jobs.push({ case: c, variantId: v.id, text: v.text, systemText: c.systemPrompt, model, rep: r });
                }
            }
        }
    }
    // Two execution paths:
    //   batch=true  — submit every job to the provider batch API, poll, score
    //                 results as they arrive. 50% cheaper, slower wall-clock.
    //   batch=false — work-stealing pool: keep `concurrency` jobs in flight so
    //                 a slow call doesn't block the others in its slice.
    const rawByKey = new Map();
    const runOnlinePool = async () => {
        let done = 0;
        let next = 0;
        const worker = async () => {
            while (true) {
                const i = next++;
                if (i >= jobs.length)
                    return;
                const r = await runSingle(jobs[i], opts, transport);
                const key = `${r.variantId}:${r.caseHash}:${r.model ?? ""}`;
                const arr = rawByKey.get(key) ?? [];
                arr.push(r);
                rawByKey.set(key, arr);
                done++;
                opts.onProgress?.(done, jobs.length, r.caseName, r.variantId);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    };
    if (opts.batch) {
        try {
            await runBatchPath(jobs, opts, rawByKey);
        }
        catch (err) {
            // Batch submission failed (Kimi's /v1/files doesn't match OpenAI,
            // OpenRouter has no batch at all, transient provider error, etc.).
            // Fall back to the online pool so the whole run doesn't die — losing
            // the 50% batch discount is better than losing the run.
            const msg = err instanceof Error ? err.message : String(err);
            opts.onBatchProgress?.(`batch path failed, falling back to online: ${msg.slice(0, 200)}`);
            rawByKey.clear(); // discard any partial state
            await runOnlinePool();
        }
    }
    else {
        await runOnlinePool();
    }
    // Adaptive sampling: for cells where any score-dim σ exceeds threshold,
    // add one more rep and rerun — up to `cap` total reps. Converges on a
    // stable estimate without wasting reps on already-stable cells.
    if (!opts.batch && opts.adaptiveReps) {
        const cap = opts.adaptiveReps.cap;
        const threshold = opts.adaptiveReps.threshold ?? 0.1;
        for (let round = 0; round < cap - reps; round++) {
            const extra = [];
            for (const v of variants) {
                for (const c of cases) {
                    for (const model of models) {
                        const key = `${v.id}:${c.hash}:${model}`;
                        const runs = rawByKey.get(key) ?? [];
                        if (runs.length >= cap)
                            continue;
                        const { stddev } = aggregateReps(runs);
                        const dims = ["parse", "schema", "content", "costEfficiency", "speed"];
                        const maxSigma = Math.max(...dims.map((d) => stddev[d]));
                        if (maxSigma > threshold) {
                            extra.push({ case: c, variantId: v.id, text: v.text, systemText: c.systemPrompt, model, rep: runs.length });
                        }
                    }
                }
            }
            if (extra.length === 0)
                break;
            opts.onProgress?.(jobs.length, jobs.length + extra.length, "adaptive", `round ${round + 1}`);
            let next = 0;
            const worker = async () => {
                while (true) {
                    const i = next++;
                    if (i >= extra.length)
                        return;
                    const r = await runSingle(extra[i], opts, transport);
                    const key = `${r.variantId}:${r.caseHash}:${r.model ?? ""}`;
                    const arr = rawByKey.get(key) ?? [];
                    arr.push(r);
                    rawByKey.set(key, arr);
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, extra.length) }, worker));
        }
    }
    // Collapse reps: one aggregated EvaluationResult per (variant, case, model).
    const aggregated = new Map();
    for (const [key, runs] of rawByKey) {
        aggregated.set(key, collapseReps(runs));
    }
    // Optional llm-judge pass on top-N variants (by current heuristic content).
    if (opts.judge)
        await runJudge(variants, cases, models, aggregated, opts.judge, opts);
    // Assemble rows: per-variant aggregate across all cases and models.
    const rows = [];
    for (const v of variants) {
        const rowResults = new Map();
        const perModel = {};
        const modelGmeans = [];
        let parseFailures = 0;
        for (const model of models) {
            const modelScores = [];
            for (const c of cases) {
                const key = `${v.id}:${c.hash}:${model}`;
                const r = aggregated.get(key);
                if (!r)
                    continue;
                rowResults.set(models.length > 1 ? `${c.hash}:${model}` : c.hash, r);
                modelScores.push(r.scores);
                if (r.scores.parse < 0.5)
                    parseFailures++;
            }
            if (modelScores.length > 0) {
                const modelAgg = averageDimensions(modelScores);
                perModel[model] = modelAgg;
                modelGmeans.push(gmean(modelAgg));
            }
        }
        const allScores = [...rowResults.values()].map((r) => r.scores);
        const aggregate = averageDimensions(allScores);
        const g = gmean(aggregate);
        let crossModelStddev;
        if (modelGmeans.length > 1) {
            const m = modelGmeans.reduce((a, b) => a + b, 0) / modelGmeans.length;
            const variance = modelGmeans.reduce((a, b) => a + (b - m) ** 2, 0) / modelGmeans.length;
            crossModelStddev = Math.sqrt(variance);
        }
        // Rep-level stddev of gmean across all per-cell results for this variant.
        // Fills the `σ gmean` report column in single-model runs, which previously
        // always showed "—" because the column was tied to crossModelStddev.
        let repsStddev;
        if (reps > 1) {
            const cellStddevs = [];
            for (const r of rowResults.values()) {
                if (r.stddev) {
                    // Use the stddev of gmean-per-rep if we had the reps at hand; since
                    // we've already collapsed, approximate with gmean of the per-dim stddevs.
                    cellStddevs.push(gmean(r.stddev));
                }
            }
            if (cellStddevs.length > 0) {
                repsStddev = cellStddevs.reduce((a, b) => a + b, 0) / cellStddevs.length;
            }
        }
        // Bootstrap CI over per-case gmean samples — if two variants' CIs overlap,
        // the ranking between them is not reliable.
        let gmeanCI;
        if (allScores.length >= 2) {
            const perCaseGmeans = [...rowResults.values()].map((r) => gmean(r.scores));
            gmeanCI = bootstrapCI(perCaseGmeans, 500);
        }
        rows.push({
            variantId: v.id,
            promptPath: v.promptPath,
            generation: v.generation,
            text: v.text,
            results: rowResults,
            aggregate,
            gmean: g,
            crossModelStddev,
            perModel: models.length > 1 ? perModel : undefined,
            parseFailures,
            repsStddev,
            gmeanCI,
        });
    }
    // Rank-order stability: split reps in half per cell, compute per-variant
    // gmeans for each half, rank variants, compare with Kendall τ. τ ≥ 0.7
    // means the ranking is trustworthy; lower than that means the benchmark
    // can't reliably order these variants.
    if (reps >= 4) {
        const halfA = halfSplitMatrix(variants, cases, models, rawByKey, 0);
        const halfB = halfSplitMatrix(variants, cases, models, rawByKey, 1);
        if (halfA.length >= 2 && halfB.length >= 2) {
            const tau = kendallTau(halfA, halfB);
            for (const row of rows)
                row.rankStability = tau;
        }
    }
    return rows;
}
/**
 * Return a variant ranking computed from only half of the reps (even or odd).
 * Used to measure whether the same reps split two ways agree on the order.
 */
function halfSplitMatrix(variants, cases, models, rawByKey, side) {
    const scored = [];
    for (const v of variants) {
        const dims = [];
        for (const c of cases) {
            for (const m of models) {
                const key = `${v.id}:${c.hash}:${m}`;
                const runs = rawByKey.get(key) ?? [];
                const half = runs.filter((_, i) => i % 2 === side);
                if (half.length === 0)
                    continue;
                dims.push(aggregateReps(half).mean);
            }
        }
        if (dims.length > 0)
            scored.push({ id: v.id, g: gmean(averageDimensions(dims)) });
    }
    scored.sort((a, b) => b.g - a.g);
    return scored.map((s) => s.id);
}
async function runBatchPath(jobs, opts, rawByKey) {
    const provider = detectBatchProvider(opts.baseUrl);
    if (provider === "unsupported") {
        throw new Error(`Batch API not supported for baseUrl=${opts.baseUrl}; rerun without --batch or point at an Anthropic / OpenAI-compatible endpoint.`);
    }
    // Build custom_ids that route results back to the right cell. Index is
    // included so reps of the same (variant, case, model) don't collide.
    const keyed = jobs.map((job, i) => ({
        job,
        index: i,
        customId: `v:${job.variantId}|h:${job.case.hash}|m:${job.model}|r:${job.rep}|i:${i}`,
    }));
    const batchJobs = keyed.map((k) => ({
        customId: k.customId,
        userText: k.job.text,
        systemText: k.job.systemText,
        model: k.job.model,
    }));
    const started = Date.now();
    const existing = opts.runId != null && opts.generation != null
        ? loadBatchState(opts.runId, opts.generation, "eval")
        : null;
    const transport = opts.batchCallModel ?? batchCallModel;
    const results = await transport(batchJobs, {
        baseUrl: opts.batchBaseUrl ?? opts.baseUrl,
        authToken: opts.batchAuthToken ?? opts.authToken,
        modelOverride: opts.batchModel,
        maxTokens: opts.maxTokens,
        resumeBatchId: existing?.batchId,
        onSubmitted: (batchId, p) => {
            if (opts.runId != null && opts.generation != null && !existing) {
                saveBatchState(opts.runId, {
                    generation: opts.generation,
                    phase: "eval",
                    batchId,
                    provider: p,
                    submittedAt: new Date().toISOString(),
                });
            }
            opts.onBatchProgress?.(`batch submitted: ${batchId} (${p})`);
        },
        onProgress: (p) => {
            if (p.phase === "polling") {
                const ok = p.succeeded ?? 0;
                const failed = p.failed ?? 0;
                const total = p.total ?? batchJobs.length;
                opts.onBatchProgress?.(`batch ${p.batchId} polling: ${ok}/${total} done${failed ? `, ${failed} failed` : ""}`);
            }
            else {
                opts.onBatchProgress?.(`batch ${p.batchId} ${p.phase}`);
            }
        },
    });
    // Mark the state entry as finished so a crash after this point doesn't
    // cause the next run to try resuming an already-consumed batch.
    if (opts.runId != null && existing)
        markBatchFinished(opts.runId, existing.batchId);
    // Score each result and populate rawByKey the same way runSingle does.
    const durationMs = Math.round((Date.now() - started) / Math.max(1, jobs.length));
    let done = 0;
    for (const k of keyed) {
        const r = results.get(k.customId);
        const raw = r?.raw ?? "batch returned no result for this custom_id";
        const costUsd = r?.costUsd ?? 0;
        const parsed = attemptJsonParse(raw);
        const scored = scoreOutput(raw, parsed, costUsd, durationMs, k.job.case, { model: k.job.model });
        scored.variantId = k.job.variantId;
        const mapKey = `${scored.variantId}:${scored.caseHash}:${scored.model ?? ""}`;
        const arr = rawByKey.get(mapKey) ?? [];
        arr.push(scored);
        rawByKey.set(mapKey, arr);
        done++;
        opts.onProgress?.(done, jobs.length, k.job.case.name, k.job.variantId);
    }
}
async function runSingle(job, opts, transport) {
    const started = Date.now();
    const callOpts = {
        model: job.model,
        baseUrl: opts.baseUrl,
        authToken: opts.authToken,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
    };
    try {
        const { raw, costUsd } = await transport(job.text, job.systemText, callOpts);
        const durationMs = Date.now() - started;
        const parsed = attemptJsonParse(raw);
        const scored = scoreOutput(raw, parsed, costUsd, durationMs, job.case, { model: job.model });
        scored.variantId = job.variantId;
        return scored;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - started;
        return {
            caseHash: job.case.hash,
            caseName: job.case.name,
            variantId: job.variantId,
            promptPath: job.case.promptPath,
            rawOutput: msg,
            parsedOutput: null,
            costUsd: 0,
            durationMs,
            scores: { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 },
            notes: [`HTTP/fetch error: ${msg.slice(0, 200)}`],
            model: job.model,
        };
    }
}
/** Collapse N repetitions into a single EvaluationResult carrying mean + stddev. */
function collapseReps(runs) {
    if (runs.length === 1)
        return runs[0];
    const { mean, stddev } = aggregateReps(runs);
    // Pick the median-quality run as the "representative" raw output, so the
    // report shows a realistic sample rather than the best or worst rep.
    const sorted = [...runs].sort((a, b) => gmean(a.scores) - gmean(b.scores));
    const mid = sorted[Math.floor(sorted.length / 2)];
    return {
        ...mid,
        scores: mean,
        stddev,
        reps: runs.length,
    };
}
/** Render a prompt variant given its source path and optional variant name */
export function renderVariant(promptPath, variant, vars) {
    return renderPrompt(promptPath, { variant, vars });
}
