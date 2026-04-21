/**
 * Curator — selects which prompt variants survive to the next generation.
 *
 * Strategy: Pareto-frontier selection on the multi-objective score vector.
 * This keeps diversity (don't collapse to a single local optimum) while
 * still promoting the best variants.
 *
 * Also applies a novelty bonus so variants that explore different strategies
 * aren't immediately crushed by a dominant but narrow winner.
 */
export function curate(rows, currentCanonGmean, opts = {}) {
    const eliteCount = opts.eliteCount ?? 3;
    const diversityCount = opts.diversityCount ?? 2;
    const promoteThreshold = opts.promoteThreshold ?? 0.02;
    if (rows.length === 0)
        return { promoted: [], quarantined: [], kept: [] };
    // 1. Compute novelty scores (cosine distance from centroid)
    const centroid = computeCentroid(rows.map((r) => vectorize(r.aggregate)));
    const withNovelty = rows.map((r) => ({
        ...r,
        novelty: cosineDistance(vectorize(r.aggregate), centroid),
    }));
    // 2. Pareto frontier: no other row dominates this one on all dimensions
    const paretoIds = new Set();
    for (const a of withNovelty) {
        let dominated = false;
        for (const b of withNovelty) {
            if (a.variantId === b.variantId)
                continue;
            if (dominates(b.aggregate, a.aggregate)) {
                dominated = true;
                break;
            }
        }
        if (!dominated)
            paretoIds.add(a.variantId);
    }
    // 3. Elite selection: best by gmean within Pareto set
    const paretoRows = withNovelty.filter((r) => paretoIds.has(r.variantId));
    paretoRows.sort((a, b) => b.gmean - a.gmean);
    const elites = paretoRows.slice(0, eliteCount);
    // 4. Diversity selection: highest novelty among non-elites
    const nonElites = withNovelty.filter((r) => !elites.some((e) => e.variantId === r.variantId));
    nonElites.sort((a, b) => b.novelty - a.novelty);
    const diverse = nonElites.slice(0, diversityCount);
    const kept = [...elites, ...diverse];
    const keptIds = new Set(kept.map((r) => r.variantId));
    // 5. Promotion: if the absolute best exceeds canon + threshold
    const best = paretoRows[0];
    const promoted = [];
    if (best && best.gmean > currentCanonGmean + promoteThreshold) {
        promoted.push(best.variantId);
    }
    // 6. Quarantine: everything not kept
    const quarantined = rows.filter((r) => !keptIds.has(r.variantId)).map((r) => r.variantId);
    return { promoted, quarantined, kept: [...keptIds] };
}
/** Returns true if a dominates b on all dimensions (and at least one strictly) */
function dominates(a, b) {
    const keys = ["parse", "schema", "content", "costEfficiency", "speed"];
    let strictlyBetter = false;
    for (const k of keys) {
        if (a[k] < b[k])
            return false;
        if (a[k] > b[k])
            strictlyBetter = true;
    }
    return strictlyBetter;
}
function vectorize(s) {
    return [s.parse, s.schema, s.content, s.costEfficiency, s.speed];
}
function computeCentroid(vectors) {
    if (vectors.length === 0)
        return [0, 0, 0, 0, 0];
    const dim = vectors[0].length;
    return Array.from({ length: dim }, (_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length);
}
function cosineDistance(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
    const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
    return 1 - sim; // distance = 1 - similarity
}
/** Pretty-print a matrix for human review */
export function formatMatrix(rows, caseNames) {
    const lines = [];
    lines.push(`| variant | gen | gmean | parse | schema | content | cost | speed |`);
    lines.push(`|---------|-----|-------|-------|--------|---------|------|-------|`);
    for (const r of rows.sort((a, b) => b.gmean - a.gmean)) {
        const s = r.aggregate;
        lines.push(`| ${r.variantId.slice(0, 12).padEnd(11)} | ${String(r.generation).padStart(3)} | ` +
            `${(r.gmean * 100).toFixed(1).padStart(5)} | ${(s.parse * 100).toFixed(0).padStart(5)} | ` +
            `${(s.schema * 100).toFixed(0).padStart(6)} | ${(s.content * 100).toFixed(0).padStart(7)} | ` +
            `${(s.costEfficiency * 100).toFixed(0).padStart(4)} | ${(s.speed * 100).toFixed(0).padStart(5)} |`);
    }
    lines.push("");
    lines.push("Per-case breakdown:");
    for (const r of rows.sort((a, b) => b.gmean - a.gmean)) {
        lines.push(`  ${r.variantId} (gen ${r.generation}):`);
        for (const name of caseNames) {
            const c = [...r.results.values()].find((x) => x.caseName === name);
            if (!c)
                continue;
            const flag = c.notes.length > 0 ? "⚠" : "✓";
            lines.push(`    ${flag} ${name}: gmean=${(gmean(c.scores) * 100).toFixed(0)}% notes=${c.notes.slice(0, 2).join("; ") || "ok"}`);
        }
    }
    return lines.join("\n");
}
function gmean(scores) {
    const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
    const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
    return Math.pow(product, 1 / vals.length);
}
