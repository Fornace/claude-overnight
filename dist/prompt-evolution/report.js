/**
 * Markdown report generator for prompt-evolution runs.
 *
 * Design: make generator artefacts (JSON discipline, noise) legible so the
 * reader can't mistake a Kimi-can't-JSON failure for a bad prompt.
 *   - parse/schema/content as top-level columns, not buried in gmean
 *   - per-case stddev when reps>1 (noise floor)
 *   - per-model breakdown + cross-model stddev when multi-model
 *   - explicit parse-failure count per variant
 */
export function generateReport(opts, result, generationMatrices) {
    const best = result.bestVariant;
    const baseline = generationMatrices[0]?.find((r) => r.variantId === "default" || r.variantId === "baseline");
    const lines = [];
    const models = opts.evalModels && opts.evalModels.length > 0 ? opts.evalModels : [opts.evalModel];
    const reps = opts.repetitions ?? 1;
    lines.push(`# Prompt Evolution Report — \`${opts.promptPath}\``);
    lines.push("");
    lines.push(`| Attribute | Value |`);
    lines.push(`|-----------|-------|`);
    lines.push(`| Run ID | \`${opts.runId}\` |`);
    lines.push(`| Target | ${opts.target} |`);
    lines.push(`| Eval model(s) | ${models.join(", ")} |`);
    lines.push(`| Repetitions | ${reps}${reps === 1 ? " (single-shot — no noise floor)" : ""} |`);
    lines.push(`| Generations | ${opts.generations} |`);
    lines.push(`| Population cap | ${generationMatrices[0]?.length ?? 0} |`);
    lines.push(`| Baseline gmean | ${baseline ? `${(baseline.gmean * 100).toFixed(1)}%` : "N/A"} |`);
    lines.push(`| Best gmean | ${(best.gmean * 100).toFixed(1)}% |`);
    lines.push(`| Improvement | ${baseline ? `${((best.gmean - baseline.gmean) * 100).toFixed(1)}pp` : "N/A"} |`);
    lines.push("");
    lines.push("## Executive Summary");
    lines.push("");
    if (baseline && best.gmean > baseline.gmean) {
        lines.push(`Best variant scores **${(best.gmean * 100).toFixed(1)}%** (baseline: ${(baseline.gmean * 100).toFixed(1)}%), Δ **${((best.gmean - baseline.gmean) * 100).toFixed(1)}pp**.`);
    }
    else if (baseline) {
        lines.push(`No improvement over baseline. Best variant scores **${(best.gmean * 100).toFixed(1)}%** (baseline: ${(baseline.gmean * 100).toFixed(1)}%).`);
    }
    else {
        lines.push(`Best variant scores **${(best.gmean * 100).toFixed(1)}%**.`);
    }
    if (reps < 2) {
        lines.push("");
        lines.push(`> **Noise warning**: reps=1 means each variant was evaluated once per case. Two scores within a few points may not differ reliably. Re-run with \`repetitions >= 3\` to establish a noise floor.`);
    }
    if (baseline && baseline.parseFailures && baseline.parseFailures > 0) {
        lines.push("");
        lines.push(`> **Parse failures on baseline**: ${baseline.parseFailures} case(s). Low content scores may reflect generator JSON discipline, not prompt quality. Check the parse column before trusting content.`);
    }
    lines.push("");
    lines.push("## Per-Generation Matrix");
    lines.push("");
    const stddevCol = reps > 1 ? " | σ gmean" : "";
    lines.push(`| Gen | Variant | gmean${stddevCol} | parse | schema | content | cost | speed | parseFail |`);
    lines.push(`|-----|---------|-------${reps > 1 ? "|-------" : ""}|-------|--------|---------|------|-------|-----------|`);
    for (let g = 0; g < generationMatrices.length; g++) {
        const rows = [...generationMatrices[g]].sort((a, b) => b.gmean - a.gmean);
        for (const r of rows) {
            const s = r.aggregate;
            const sigma = reps > 1 ? ` | ${r.crossModelStddev != null ? (r.crossModelStddev * 100).toFixed(1) : "—"}` : "";
            lines.push(`| ${g} | ${r.variantId.slice(0, 16)} | ${(r.gmean * 100).toFixed(1)}${sigma} | ` +
                `${pct(s.parse)} | ${pct(s.schema)} | ${pct(s.content)} | ` +
                `${pct(s.costEfficiency)} | ${pct(s.speed)} | ${r.parseFailures ?? 0} |`);
        }
    }
    lines.push("");
    // Per-model breakdown (only if multi-model)
    if (models.length > 1) {
        lines.push("## Cross-Model Breakdown (final generation)");
        lines.push("");
        lines.push("A prompt that scores well on one model and poorly on another is fragile. High cross-model σ is a warning sign.");
        lines.push("");
        const finalMatrix = generationMatrices[generationMatrices.length - 1] ?? [];
        lines.push(`| Variant | ${models.map((m) => shorten(m)).join(" | ")} | σ |`);
        lines.push(`|---------|${models.map(() => "---").join("|")}|---|`);
        for (const r of finalMatrix) {
            if (!r.perModel)
                continue;
            const cells = models.map((m) => {
                const dims = r.perModel?.[m];
                return dims ? pct(aggGmean(dims)) : "—";
            });
            lines.push(`| ${r.variantId.slice(0, 16)} | ${cells.join(" | ")} | ${r.crossModelStddev != null ? (r.crossModelStddev * 100).toFixed(1) : "—"} |`);
        }
        lines.push("");
    }
    lines.push("## Learning Log");
    lines.push("");
    if (result.learningLog.length === 0) {
        lines.push("_No mutations were attempted (single-generation run or all variants were baseline)._");
    }
    else {
        lines.push(`| Gen | Mutation | Δ fitness | Status |`);
        lines.push(`|-----|----------|-----------|--------|`);
        for (const l of result.learningLog) {
            lines.push(`| ${l.generation} | ${l.mutationSummary} | ${(l.fitnessDelta * 100).toFixed(1)}% | ${l.status} |`);
        }
    }
    lines.push("");
    lines.push("## Best Prompt Variant");
    lines.push("");
    lines.push(`**ID**: \`${best.variantId}\`  `);
    lines.push(`**Generation**: ${best.generation}  `);
    lines.push(`**gmean**: ${(best.gmean * 100).toFixed(1)}%  `);
    lines.push("");
    lines.push("```markdown");
    lines.push(best.text);
    lines.push("```");
    lines.push("");
    if (opts.baselineText && opts.baselineText !== best.text) {
        lines.push("## Diff vs Baseline");
        lines.push("");
        lines.push("```diff");
        lines.push(...simpleDiff(opts.baselineText, best.text));
        lines.push("```");
        lines.push("");
    }
    lines.push("## Recommendations");
    lines.push("");
    const recs = [];
    if (best.parseFailures && best.parseFailures > 0) {
        recs.push(`- **${best.parseFailures} parse failure(s) in the best variant**. Before tuning content, fix JSON discipline — add an explicit output-format block or switch eval model.`);
    }
    if (best.aggregate.parse < 0.9)
        recs.push("- **Parse reliability** is below 90%. Consider adding explicit JSON formatting instructions or reducing output complexity.");
    if (best.aggregate.schema < 0.9)
        recs.push("- **Schema compliance** is below 90%. Add required-field reminders or an example shape in the prompt.");
    if (best.aggregate.content < 0.7)
        recs.push("- **Content quality** is weak. Enable llm-judge (pass `judge` in EvalOpts) for a semantic read instead of regex heuristics.");
    if (best.aggregate.costEfficiency < 0.5)
        recs.push("- **Cost efficiency** is low. The model is generating too much text — add length limits or summarisation instructions.");
    if (best.aggregate.speed < 0.5)
        recs.push("- **Speed** is low. Consider using a faster evaluation model or reducing max_tokens.");
    if (best.crossModelStddev != null && best.crossModelStddev > 0.1) {
        recs.push(`- **Cross-model σ = ${(best.crossModelStddev * 100).toFixed(1)}%**. The best prompt is not robust across generators — check the per-model breakdown above.`);
    }
    if (reps < 3)
        recs.push("- **Run with repetitions>=3** to establish a noise floor before trusting ranking.");
    if (recs.length === 0)
        recs.push("- All dimensions are healthy. This variant is a good candidate for promotion to canon.");
    lines.push(...recs);
    lines.push("");
    return lines.join("\n");
}
function pct(n) { return (n * 100).toFixed(0); }
function shorten(model) {
    // "claude-haiku-4-5" → "haiku", "zai-org/GLM-5.1-TEE" → "GLM"
    const tail = model.split("/").pop() ?? model;
    const parts = tail.split("-");
    return parts[0] === "claude" && parts.length > 1 ? parts[1] : parts[0];
}
function aggGmean(s) {
    const vals = [s.parse, s.schema, s.content, s.costEfficiency, s.speed];
    const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
    return Math.pow(product, 1 / vals.length);
}
function simpleDiff(a, b) {
    const al = a.split("\n");
    const bl = b.split("\n");
    const out = [];
    const max = Math.max(al.length, bl.length);
    for (let i = 0; i < max; i++) {
        const left = al[i] ?? "";
        const right = bl[i] ?? "";
        if (left === right)
            out.push(` ${left}`);
        else if (!right)
            out.push(`-${left}`);
        else if (!left)
            out.push(`+${right}`);
        else {
            out.push(`-${left}`);
            out.push(`+${right}`);
        }
    }
    return out;
}
