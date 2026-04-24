/**
 * Scoring logic for prompt evolution benchmarks.
 *
 * Split in three concerns, reported as separate dimensions so a JSON
 * discipline failure never masquerades as a content failure:
 *   parse   — was the output valid JSON (when expected)?
 *   schema  — did the object include the required fields?
 *   content — are the tasks independent / specific / in a sane budget band?
 *
 * Content is the only dimension that can optionally be replaced by an
 * llm-judge score (see llm-judge.ts). Everything else stays deterministic
 * so we can diff runs without paying for a judge call.
 */
export function scoreOutput(raw, parsed, costUsd, durationMs, c, inputs = {}) {
    const notes = [];
    const cr = c.criteria;
    // ── Parse ──
    let parse = 0;
    if (parsed !== null && typeof parsed === "object") {
        parse = 1;
    }
    else {
        notes.push("Output is not valid JSON or not an object");
    }
    // ── Schema ──
    let schema = 0;
    if (parse === 1 && cr.requiredJsonFields && cr.requiredJsonFields.length > 0) {
        const obj = parsed;
        const missing = cr.requiredJsonFields.filter((f) => !(f in obj));
        if (missing.length === 0) {
            schema = 1;
        }
        else {
            schema = (cr.requiredJsonFields.length - missing.length) / cr.requiredJsonFields.length;
            notes.push(`Missing JSON fields: ${missing.join(", ")}`);
        }
    }
    else if (!cr.requiredJsonFields || cr.requiredJsonFields.length === 0) {
        schema = 1;
    }
    // ── Content ──
    // Default: heuristic sub-scores (budget sanity, independence, specificity).
    // When an llm-judge score is supplied, it REPLACES the heuristic content —
    // the judge reads the objective and the output, which is strictly more signal.
    let content = 0;
    if (inputs.judgeContent != null) {
        content = clamp01(inputs.judgeContent);
    }
    else if (parse === 1 && schema === 1) {
        content = heuristicContent(parsed, c, notes);
    }
    // ── Cost efficiency ──
    // $0.001 → 0.91, $0.01 → 0.5, $0.10 → 0.09
    const costEfficiency = 1 / (1 + costUsd * 100);
    // ── Speed ──
    // 1s → 0.91, 10s → 0.5, 60s → 0.14
    const speed = 1 / (1 + durationMs / 10_000);
    return {
        caseHash: c.hash,
        caseName: c.name,
        variantId: "",
        promptPath: c.promptPath,
        rawOutput: raw,
        parsedOutput: parsed,
        costUsd,
        durationMs,
        scores: { parse, schema, content, costEfficiency, speed },
        notes,
        model: inputs.model,
        judgeJustification: inputs.judgeJustification,
    };
}
function heuristicContent(obj, c, notes) {
    const cr = c.criteria;
    const subScores = [];
    const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
    // Budget-band sanity. If the case's vars carry a `budget`, we expect the
    // output to land within an order of magnitude. This is a cheap sanity gate,
    // not a grade — if the prompt claims "budget=5" and returns 0 or 50 tasks,
    // something is broken. The narrow judgment is the llm-judge's job.
    const budget = typeof c.vars.budget === "number" ? c.vars.budget : undefined;
    if (budget != null && budget > 0) {
        if (tasks.length === 0) {
            subScores.push(0);
            notes.push(`Empty tasks array for budget=${budget}`);
        }
        else if (tasks.length > budget * 5) {
            subScores.push(0.2);
            notes.push(`Task count ${tasks.length} vastly exceeds budget=${budget}`);
        }
        else {
            subScores.push(1);
        }
    }
    if (cr.independentTasks && tasks.length > 0) {
        const dependencyWords = /\b(after|before|then|depends?\s+on|follow|subsequent|once\s+.*\s+done|upon\s+completion)\b/gi;
        const dependent = tasks.filter((t) => {
            const text = typeof t === "string" ? t : t?.prompt ?? "";
            return dependencyWords.test(text);
        });
        if (dependent.length === 0) {
            subScores.push(1);
        }
        else {
            subScores.push(Math.max(0, 1 - dependent.length / tasks.length));
            notes.push(`${dependent.length} task(s) appear to have dependencies`);
        }
    }
    if (cr.specificTasks && tasks.length > 0) {
        const filePattern = /\b(src\/|lib\/|app\/|test\/|spec\/|\.[tj]sx?\b|\.py\b|\.go\b|\.rs\b)/i;
        const funcPattern = /\b(function|method|class|component|module|route|handler)\b|\(\s*\)/i;
        const specific = tasks.filter((t) => {
            const text = typeof t === "string" ? t : t?.prompt ?? "";
            return filePattern.test(text) || funcPattern.test(text);
        });
        subScores.push(specific.length / tasks.length);
        if (specific.length < tasks.length) {
            notes.push(`${tasks.length - specific.length} task(s) lack file/function specificity`);
        }
    }
    if (subScores.length === 0)
        return 1; // nothing required → content is satisfied
    return subScores.reduce((a, b) => a + b, 0) / subScores.length;
}
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(1, n));
}
/** Geometric mean of score dimensions — rewards balanced performance */
export function gmean(scores) {
    const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
    const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
    return Math.pow(product, 1 / vals.length);
}
/** Arithmetic mean for quick human reading */
export function amean(scores) {
    const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}
/** Aggregate multiple runs of the same (variant, case) into mean + stddev. */
export function aggregateReps(results) {
    const n = results.length;
    if (n === 0) {
        const zero = { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 };
        return { mean: zero, stddev: zero };
    }
    const keys = ["parse", "schema", "content", "costEfficiency", "speed"];
    const mean = {};
    const stddev = {};
    for (const k of keys) {
        const vals = results.map((r) => r.scores[k]);
        const m = vals.reduce((a, b) => a + b, 0) / n;
        mean[k] = m;
        if (n === 1) {
            stddev[k] = 0;
        }
        else {
            const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / n;
            stddev[k] = Math.sqrt(variance);
        }
    }
    return { mean, stddev };
}
/**
 * Bootstrap 95% confidence interval over a sample. Resamples with
 * replacement `iterations` times, takes the 2.5th and 97.5th percentile
 * of the resampled means. Used to decide whether two variants differ
 * for real or sit within each other's noise.
 */
export function bootstrapCI(values, iterations = 1000) {
    if (values.length === 0)
        return [0, 0];
    if (values.length === 1)
        return [values[0], values[0]];
    const means = [];
    for (let iter = 0; iter < iterations; iter++) {
        let sum = 0;
        for (let j = 0; j < values.length; j++) {
            sum += values[Math.floor(Math.random() * values.length)];
        }
        means.push(sum / values.length);
    }
    means.sort((a, b) => a - b);
    const lo = Math.floor(iterations * 0.025);
    const hi = Math.floor(iterations * 0.975);
    return [means[lo], means[hi]];
}
/**
 * Paired sign-flip permutation test for the null hypothesis mean(diffs) = 0.
 *
 * More honest than "95% CIs overlap" for ranking variants:
 *   - non-parametric (no normality assumption — important for our bimodal
 *     parse-failure data)
 *   - respects pairing (same case, different variants → paired samples)
 *   - accounts for dependence between within-case outcomes
 *
 * Input: per-case paired differences (variantA_score - variantB_score).
 * Output: two-tailed p-value under H0: mean difference = 0.
 *
 * With `iterations=10000` the p-value has ±0.01 resolution, plenty for
 * the α=0.05 / α=0.01 decision thresholds we care about.
 */
export function pairedPermutationTest(diffs, iterations = 10000) {
    if (diffs.length === 0)
        return { pValue: 1, observed: 0, effectSize: 0 };
    const n = diffs.length;
    const observed = diffs.reduce((a, b) => a + b, 0) / n;
    const absObserved = Math.abs(observed);
    // σ_d / √n standardised effect (Cohen's d for paired data, loosely).
    const mean = observed;
    const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
    const stddev = Math.sqrt(variance);
    const effectSize = stddev > 0 ? observed / stddev : 0;
    let asExtreme = 0;
    for (let iter = 0; iter < iterations; iter++) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            // Flip sign of each paired diff with 50% probability → null distribution
            // over all 2^n sign patterns (we sample from it).
            sum += (Math.random() < 0.5 ? -1 : 1) * diffs[i];
        }
        if (Math.abs(sum / n) >= absObserved)
            asExtreme++;
    }
    return { pValue: asExtreme / iterations, observed, effectSize };
}
/**
 * Kendall τ rank correlation between two same-length orderings of ids.
 * Returns 1.0 for identical rankings, -1.0 for reversed, 0 for random.
 * We use this to check whether splitting the reps in half produces the
 * same per-variant ordering twice — low τ means the benchmark is noise.
 */
export function kendallTau(rankA, rankB) {
    if (rankA.length !== rankB.length || rankA.length < 2)
        return 1;
    const n = rankA.length;
    const posB = new Map();
    rankB.forEach((id, i) => posB.set(id, i));
    let concordant = 0;
    let discordant = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const ai = i;
            const aj = j;
            const bi = posB.get(rankA[i]);
            const bj = posB.get(rankA[j]);
            if (bi == null || bj == null)
                continue;
            if ((ai < aj && bi < bj) || (ai > aj && bi > bj))
                concordant++;
            else if (ai !== aj && bi !== bj)
                discordant++;
        }
    }
    const denom = (n * (n - 1)) / 2;
    return denom === 0 ? 1 : (concordant - discordant) / denom;
}
