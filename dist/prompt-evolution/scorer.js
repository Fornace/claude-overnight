/**
 * Scoring logic for prompt evolution benchmarks.
 *
 * Goals:
 * - Fast, deterministic, no extra LLM calls for basic criteria.
 * - Multi-dimensional so we don't over-fit to one metric.
 * - Normalised 0–1 so different dimensions are comparable.
 */
export function scoreOutput(raw, parsed, costUsd, durationMs, c) {
    const notes = [];
    const cr = c.criteria;
    // ── Parse score ──
    let parse = 0;
    if (parsed !== null && typeof parsed === "object") {
        parse = 1;
    }
    else {
        notes.push("Output is not valid JSON or not an object");
    }
    // ── Schema score ──
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
        schema = 1; // nothing required
    }
    // ── Content score (composite of sub-dimensions) ──
    let content = 0;
    const subScores = [];
    if (parse === 1 && schema === 1) {
        const obj = parsed;
        // Task count check
        if (cr.expectedTaskCount != null) {
            const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
            const tol = cr.taskCountTolerance ?? 0.25;
            const min = Math.floor(cr.expectedTaskCount * (1 - tol));
            const max = Math.ceil(cr.expectedTaskCount * (1 + tol));
            if (tasks.length >= min && tasks.length <= max) {
                subScores.push(1);
            }
            else {
                const dist = Math.min(Math.abs(tasks.length - min), Math.abs(tasks.length - max));
                const penalty = Math.min(dist / cr.expectedTaskCount, 1);
                subScores.push(Math.max(0, 1 - penalty));
                notes.push(`Task count ${tasks.length} outside target [${min}, ${max}]`);
            }
        }
        // Independence check
        if (cr.independentTasks) {
            const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
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
        // Specificity check
        if (cr.specificTasks) {
            const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
            const filePattern = /\b(src\/|lib\/|app\/|test\/|spec\/|\.[tj]sx?\b|\.py\b|\.go\b|\.rs\b)/i;
            const funcPattern = /\b(function|method|class|component|module|route|handler)\b|\(\s*\)/i;
            const specific = tasks.filter((t) => {
                const text = typeof t === "string" ? t : t?.prompt ?? "";
                return filePattern.test(text) || funcPattern.test(text);
            });
            if (tasks.length > 0) {
                subScores.push(specific.length / tasks.length);
                if (specific.length < tasks.length) {
                    notes.push(`${tasks.length - specific.length} task(s) lack file/function specificity`);
                }
            }
        }
    }
    content = subScores.length > 0 ? subScores.reduce((a, b) => a + b, 0) / subScores.length : 0;
    // ── Cost efficiency ──
    // $0.001 → 0.91, $0.01 → 0.5, $0.10 → 0.09
    const costEfficiency = 1 / (1 + costUsd * 100);
    // ── Speed ──
    // 1s → 0.91, 10s → 0.5, 60s → 0.14
    const speed = 1 / (1 + durationMs / 10_000);
    return {
        caseHash: c.hash,
        caseName: c.name,
        variantId: "", // filled by evaluator
        promptPath: c.promptPath,
        rawOutput: raw,
        parsedOutput: parsed,
        costUsd,
        durationMs,
        scores: { parse, schema, content, costEfficiency, speed },
        notes,
    };
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
