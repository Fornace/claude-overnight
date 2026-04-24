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

import { gmean as scoreGmean, pairedPermutationTest } from "./scorer.js";
import type { VariantRow, EvolutionResult, ScoreDimensions } from "./types.js";

export interface ReportOpts {
  runId: string;
  promptPath: string;
  target: string;
  evalModel: string;
  evalModels?: string[];
  repetitions?: number;
  generations: number;
  baselineText?: string;
}

export function generateReport(
  opts: ReportOpts,
  result: EvolutionResult,
  generationMatrices: VariantRow[][],
  testMatrix?: VariantRow[],
): string {
  const best = result.bestVariant;
  const baseline = generationMatrices[0]?.find((r) => r.variantId === "default" || r.variantId === "baseline");

  const lines: string[] = [];
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

  // When we have held-out test cases, lead the summary with those numbers
  // — they're the selection-bias-free ground truth. Train scores get a
  // secondary callout showing overfit (train >> test) if present.
  const testBest = testMatrix
    ? testMatrix.find((r) => r.variantId === best.variantId) ?? testMatrix.reduce((a, b) => (a.gmean > b.gmean ? a : b))
    : undefined;
  const testBaseline = testMatrix
    ? testMatrix.find((r) => r.variantId === "default" || r.variantId === "baseline")
    : undefined;

  // Paired permutation test on winner vs baseline — proper significance
  // check instead of the conservative "CIs overlap" heuristic.
  let permP: number | undefined;
  let permDelta: number | undefined;
  if (testBest && testBaseline && testBest.variantId !== testBaseline.variantId) {
    const diffs = collectPairedDifferences(testBest, testBaseline);
    if (diffs.length >= 3) {
      const perm = pairedPermutationTest(diffs, 10000);
      permP = perm.pValue;
      permDelta = perm.observed;
    }
  }

  lines.push("## Executive Summary");
  lines.push("");
  if (testBest) {
    const trainBest = best;
    const overfit = trainBest.gmean - testBest.gmean;
    const overfitWarn = overfit > 0.08
      ? ` · **overfit risk** (train ${(trainBest.gmean * 100).toFixed(1)}% vs test ${(testBest.gmean * 100).toFixed(1)}%, Δ ${(overfit * 100).toFixed(1)}pp)`
      : overfit > 0.03
        ? ` (train/test gap ${(overfit * 100).toFixed(1)}pp — modest)`
        : " (train/test agree — robust)";
    const testCI = testBest.gmeanCI ? ` (CI ${(testBest.gmeanCI[0] * 100).toFixed(1)}–${(testBest.gmeanCI[1] * 100).toFixed(1)}%)` : "";
    lines.push(`**Held-out test: best variant \`${testBest.variantId}\` scores ${(testBest.gmean * 100).toFixed(1)}%${testCI}**${overfitWarn}.`);
    if (testBaseline && permP != null && permDelta != null) {
      const sig = permP < 0.01 ? "**highly significant**"
        : permP < 0.05 ? "**significant**"
        : permP < 0.10 ? "marginal"
        : "**not significant** (could be noise)";
      lines.push("");
      lines.push(`Winner Δ ${(permDelta * 100).toFixed(1)}pp over baseline on held-out cases, paired permutation p = **${permP.toFixed(3)}** — ${sig}.`);
    }
  } else if (baseline && best.gmean > baseline.gmean) {
    const bestCI = best.gmeanCI ? ` (95% CI ${(best.gmeanCI[0] * 100).toFixed(1)}–${(best.gmeanCI[1] * 100).toFixed(1)}%)` : "";
    const blCI = baseline.gmeanCI ? ` (CI ${(baseline.gmeanCI[0] * 100).toFixed(1)}–${(baseline.gmeanCI[1] * 100).toFixed(1)}%)` : "";
    const overlap = baseline.gmeanCI && best.gmeanCI && baseline.gmeanCI[1] > best.gmeanCI[0];
    const reliability = overlap ? " — **CIs overlap, ranking may not be reliable** (consider --test-split for a held-out eval)" : "";
    lines.push(`Best variant scores **${(best.gmean * 100).toFixed(1)}%**${bestCI}, Δ **${((best.gmean - baseline.gmean) * 100).toFixed(1)}pp** over baseline ${(baseline.gmean * 100).toFixed(1)}%${blCI}${reliability}.`);
    lines.push("");
    lines.push(`> **Note**: scored on the same cases used to pick the winner — selection bias inflates this number. Add \`--test-split 0.3\` to get a held-out eval with a proper paired permutation p-value.`);
  } else if (baseline) {
    lines.push(`No improvement over baseline. Best variant scores **${(best.gmean * 100).toFixed(1)}%** (baseline: ${(baseline.gmean * 100).toFixed(1)}%).`);
  } else {
    lines.push(`Best variant scores **${(best.gmean * 100).toFixed(1)}%**.`);
  }
  if (best.rankStability != null) {
    const solid = best.rankStability >= 0.7;
    lines.push(`Rank stability τ = **${best.rankStability.toFixed(2)}**${solid ? " — ranking agrees across rep-split halves." : " — **ranking unstable, add more reps**."}`);
  }

  // Full train/test table when held-out eval ran.
  if (testMatrix && testMatrix.length > 0) {
    lines.push("");
    lines.push("## Held-Out Test Results");
    lines.push("");
    lines.push("These cases were never used for mutation or curation. Ranking here is selection-bias-free.");
    lines.push("");
    lines.push(`| Variant | test gmean | train gmean | Δ (overfit) | parse | schema | content |`);
    lines.push(`|---------|-----------|-------------|-------------|-------|--------|---------|`);
    for (const tr of [...testMatrix].sort((a, b) => b.gmean - a.gmean)) {
      const trainRow = generationMatrices[generationMatrices.length - 1]?.find((r) => r.variantId === tr.variantId);
      const overfit = trainRow ? (trainRow.gmean - tr.gmean) * 100 : 0;
      lines.push(
        `| ${tr.variantId.slice(0, 16)} | ${(tr.gmean * 100).toFixed(1)} | ` +
        `${trainRow ? (trainRow.gmean * 100).toFixed(1) : "—"} | ${overfit >= 0 ? "+" : ""}${overfit.toFixed(1)}pp | ` +
        `${pct(tr.aggregate.parse)} | ${pct(tr.aggregate.schema)} | ${pct(tr.aggregate.content)} |`,
      );
    }
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
  const ciCol = reps > 1 ? " | 95% CI" : "";
  lines.push(`| Gen | Variant | gmean${stddevCol}${ciCol} | parse | schema | content | cost | speed | parseFail |`);
  lines.push(`|-----|---------|-------${reps > 1 ? "|-------|-------" : ""}|-------|--------|---------|------|-------|-----------|`);
  for (let g = 0; g < generationMatrices.length; g++) {
    const rows = [...generationMatrices[g]].sort((a, b) => b.gmean - a.gmean);
    for (const r of rows) {
      const s = r.aggregate;
      // Prefer repsStddev for single-model runs (reps noise floor);
      // fall back to crossModelStddev for multi-model runs; dash if neither.
      const sigma = reps > 1
        ? ` | ${r.repsStddev != null ? (r.repsStddev * 100).toFixed(1) : r.crossModelStddev != null ? (r.crossModelStddev * 100).toFixed(1) : "—"}`
        : "";
      const ci = reps > 1
        ? ` | ${r.gmeanCI ? `${(r.gmeanCI[0] * 100).toFixed(1)}–${(r.gmeanCI[1] * 100).toFixed(1)}` : "—"}`
        : "";
      lines.push(
        `| ${g} | ${r.variantId.slice(0, 16)} | ${(r.gmean * 100).toFixed(1)}${sigma}${ci} | ` +
        `${pct(s.parse)} | ${pct(s.schema)} | ${pct(s.content)} | ` +
        `${pct(s.costEfficiency)} | ${pct(s.speed)} | ${r.parseFailures ?? 0} |`,
      );
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
      if (!r.perModel) continue;
      const cells = models.map((m) => {
        const dims = r.perModel?.[m];
        return dims ? pct(aggGmean(dims)) : "—";
      });
      lines.push(`| ${r.variantId.slice(0, 16)} | ${cells.join(" | ")} | ${r.crossModelStddev != null ? (r.crossModelStddev * 100).toFixed(1) : "—"} |`);
    }
    lines.push("");
  }

  // Pareto section: surface variants on the (cost, content) frontier.
  // A variant is on the frontier if no other variant beats it on BOTH
  // axes. When two variants trade cost for quality, the user should see
  // both — gmean alone hides the tradeoff.
  {
    const finalMatrix = generationMatrices[generationMatrices.length - 1] ?? [];
    const frontier = paretoFrontier(finalMatrix);
    if (frontier.length > 1) {
      lines.push("## Pareto Frontier (content vs cost)");
      lines.push("");
      lines.push("Variants that no other variant beats on **both** content and cost. When the frontier has >1 member, you're picking a tradeoff, not a single winner.");
      lines.push("");
      lines.push(`| Variant | content | costEff |`);
      lines.push(`|---------|---------|---------|`);
      for (const r of frontier) {
        lines.push(`| ${r.variantId.slice(0, 16)} | ${pct(r.aggregate.content)} | ${pct(r.aggregate.costEfficiency)} |`);
      }
      lines.push("");
    }
  }

  lines.push("## Learning Log");
  lines.push("");
  if (result.learningLog.length === 0) {
    lines.push("_No mutations were attempted (single-generation run or all variants were baseline)._");
  } else {
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
  const recs: string[] = [];
  if (best.parseFailures && best.parseFailures > 0) {
    recs.push(`- **${best.parseFailures} parse failure(s) in the best variant**. Before tuning content, fix JSON discipline — add an explicit output-format block or switch eval model.`);
  }
  if (best.aggregate.parse < 0.9) recs.push("- **Parse reliability** is below 90%. Consider adding explicit JSON formatting instructions or reducing output complexity.");
  if (best.aggregate.schema < 0.9) recs.push("- **Schema compliance** is below 90%. Add required-field reminders or an example shape in the prompt.");
  if (best.aggregate.content < 0.7) recs.push("- **Content quality** is weak. Enable llm-judge (pass `judge` in EvalOpts) for a semantic read instead of regex heuristics.");
  if (best.aggregate.costEfficiency < 0.5) recs.push("- **Cost efficiency** is low. The model is generating too much text — add length limits or summarisation instructions.");
  if (best.aggregate.speed < 0.5) recs.push("- **Speed** is low. Consider using a faster evaluation model or reducing max_tokens.");
  if (best.crossModelStddev != null && best.crossModelStddev > 0.1) {
    recs.push(`- **Cross-model σ = ${(best.crossModelStddev * 100).toFixed(1)}%**. The best prompt is not robust across generators — check the per-model breakdown above.`);
  }
  if (reps < 3) recs.push("- **Run with repetitions>=3** to establish a noise floor before trusting ranking.");
  if (recs.length === 0) recs.push("- All dimensions are healthy. This variant is a good candidate for promotion to canon.");
  lines.push(...recs);
  lines.push("");

  return lines.join("\n");
}

function pct(n: number): string { return (n * 100).toFixed(0); }

/**
 * Collect per-case paired gmean differences between two variant rows.
 * Keys are case hashes (prefix if multi-model) so we pair the same
 * case across both variants.
 */
function collectPairedDifferences(a: VariantRow, b: VariantRow): number[] {
  const out: number[] = [];
  for (const [key, rA] of a.results) {
    const rB = b.results.get(key);
    if (!rB) continue;
    out.push(scoreGmean(rA.scores) - scoreGmean(rB.scores));
  }
  return out;
}

/** Pareto frontier over (content, costEfficiency) — maximize both. */
function paretoFrontier(rows: VariantRow[]): VariantRow[] {
  return rows.filter((r) => {
    for (const other of rows) {
      if (other === r) continue;
      if (other.aggregate.content >= r.aggregate.content &&
          other.aggregate.costEfficiency >= r.aggregate.costEfficiency &&
          (other.aggregate.content > r.aggregate.content ||
           other.aggregate.costEfficiency > r.aggregate.costEfficiency)) {
        return false; // dominated
      }
    }
    return true;
  });
}

function shorten(model: string): string {
  // "claude-haiku-4-5" → "haiku", "zai-org/GLM-5.1-TEE" → "GLM"
  const tail = model.split("/").pop() ?? model;
  const parts = tail.split("-");
  return parts[0] === "claude" && parts.length > 1 ? parts[1] : parts[0];
}

function aggGmean(s: ScoreDimensions): number {
  const vals = [s.parse, s.schema, s.content, s.costEfficiency, s.speed];
  const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
  return Math.pow(product, 1 / vals.length);
}

function simpleDiff(a: string, b: string): string[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: string[] = [];
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    const left = al[i] ?? "";
    const right = bl[i] ?? "";
    if (left === right) out.push(` ${left}`);
    else if (!right) out.push(`-${left}`);
    else if (!left) out.push(`+${right}`);
    else { out.push(`-${left}`); out.push(`+${right}`); }
  }
  return out;
}
