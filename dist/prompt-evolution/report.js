/**
 * Markdown report generator for prompt-evolution runs.
 *
 * Generates a structured report similar to Hermes autoresearch:
 *   - Executive summary with best variant metrics
 *   - Per-generation matrix breakdown
 *   - Learning log with fitness deltas
 *   - Prompt diff (best vs baseline)
 *   - Actionable recommendations
 */
export function generateReport(opts, result, generationMatrices) {
    const best = result.bestVariant;
    const baseline = generationMatrices[0]?.find((r) => r.variantId === "default" || r.variantId === "baseline");
    const lines = [];
    lines.push(`# Prompt Evolution Report — \`${opts.promptPath}\``);
    lines.push("");
    lines.push(`| Attribute | Value |`);
    lines.push(`|-----------|-------|`);
    lines.push(`| Run ID | \`${opts.runId}\` |`);
    lines.push(`| Target | ${opts.target} |`);
    lines.push(`| Eval model | ${opts.evalModel} |`);
    lines.push(`| Generations | ${opts.generations} |`);
    lines.push(`| Population cap | ${generationMatrices[0]?.length ?? 0} |`);
    lines.push(`| Baseline gmean | ${baseline ? `${(baseline.gmean * 100).toFixed(1)}%` : "N/A"} |`);
    lines.push(`| Best gmean | ${(best.gmean * 100).toFixed(1)}% |`);
    lines.push(`| Improvement | ${baseline ? `${((best.gmean - baseline.gmean) * 100).toFixed(1)}pp` : "N/A"} |`);
    lines.push("");
    // Executive summary
    lines.push("## Executive Summary");
    lines.push("");
    if (baseline && best.gmean > baseline.gmean) {
        lines.push(`The evolution run produced a variant that scores **${(best.gmean * 100).toFixed(1)}%** (baseline: ${(baseline.gmean * 100).toFixed(1)}%), an improvement of **${((best.gmean - baseline.gmean) * 100).toFixed(1)} percentage points**.`);
    }
    else if (baseline) {
        lines.push(`No improvement over baseline was found. The best variant scores **${(best.gmean * 100).toFixed(1)}%** (baseline: ${(baseline.gmean * 100).toFixed(1)}%).`);
    }
    else {
        lines.push(`The best variant scores **${(best.gmean * 100).toFixed(1)}%**.`);
    }
    lines.push("");
    // Per-generation matrix
    lines.push("## Per-Generation Matrix");
    lines.push("");
    lines.push(`| Gen | Variant | gmean | parse | schema | content | cost | speed |`);
    lines.push(`|-----|---------|-------|-------|--------|---------|------|-------|`);
    for (let g = 0; g < generationMatrices.length; g++) {
        const rows = generationMatrices[g].sort((a, b) => b.gmean - a.gmean);
        for (const r of rows) {
            const s = r.aggregate;
            lines.push(`| ${g} | ${r.variantId.slice(0, 16)} | ${(r.gmean * 100).toFixed(1)} | ` +
                `${(s.parse * 100).toFixed(0)} | ${(s.schema * 100).toFixed(0)} | ${(s.content * 100).toFixed(0)} | ` +
                `${(s.costEfficiency * 100).toFixed(0)} | ${(s.speed * 100).toFixed(0)} |`);
        }
    }
    lines.push("");
    // Learning log
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
    // Best prompt
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
    // Diff vs baseline
    if (opts.baselineText && opts.baselineText !== best.text) {
        lines.push("## Diff vs Baseline");
        lines.push("");
        lines.push("```diff");
        lines.push(...simpleDiff(opts.baselineText, best.text));
        lines.push("```");
        lines.push("");
    }
    // Recommendations
    lines.push("## Recommendations");
    lines.push("");
    const recs = [];
    if (best.aggregate.parse < 0.9)
        recs.push("- **Parse reliability** is below 90%. Consider adding explicit JSON formatting instructions or reducing output complexity.");
    if (best.aggregate.schema < 0.9)
        recs.push("- **Schema compliance** is below 90%. Add required-field reminders or an example shape in the prompt.");
    if (best.aggregate.content < 0.7)
        recs.push("- **Content quality** is weak. The prompt may need stronger role definition or more detailed task constraints.");
    if (best.aggregate.costEfficiency < 0.5)
        recs.push("- **Cost efficiency** is low. The model is generating too much text — add length limits or summarisation instructions.");
    if (best.aggregate.speed < 0.5)
        recs.push("- **Speed** is low. Consider using a faster evaluation model or reducing max_tokens.");
    if (recs.length === 0)
        recs.push("- All dimensions are healthy. This variant is a good candidate for promotion to canon.");
    lines.push(...recs);
    lines.push("");
    return lines.join("\n");
}
/** Very simple line-based diff for the report. */
function simpleDiff(a, b) {
    const al = a.split("\n");
    const bl = b.split("\n");
    const out = [];
    const max = Math.max(al.length, bl.length);
    for (let i = 0; i < max; i++) {
        const left = al[i] ?? "";
        const right = bl[i] ?? "";
        if (left === right) {
            out.push(` ${left}`);
        }
        else if (!right) {
            out.push(`-${left}`);
        }
        else if (!left) {
            out.push(`+${right}`);
        }
        else {
            out.push(`-${left}`);
            out.push(`+${right}`);
        }
    }
    return out;
}
