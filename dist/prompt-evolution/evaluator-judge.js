/**
 * LLM-judge pass over a built evaluation matrix.
 *
 * The judge REPLACES the heuristic content score with a semantic grade.
 * We only judge top-N variants per generation to cap cost — a judge call
 * per (variant, case, model) on a large population explodes fast.
 */
import { judgeOutput } from "./llm-judge.js";
import { gmean } from "./scorer.js";
import { averageDimensions } from "./evaluator-utils.js";
export async function runJudge(variants, cases, models, aggregated, judge) {
    const topN = judge.topN ?? 4;
    const variantGmeans = variants.map((v) => {
        const scores = [];
        for (const c of cases) {
            for (const model of models) {
                const r = aggregated.get(`${v.id}:${c.hash}:${model}`);
                if (r)
                    scores.push(r.scores);
            }
        }
        return { id: v.id, g: scores.length > 0 ? gmean(averageDimensions(scores)) : 0 };
    });
    variantGmeans.sort((a, b) => b.g - a.g);
    const eligible = new Set(variantGmeans.slice(0, topN).map((x) => x.id));
    const cells = [];
    for (const v of variants) {
        if (!eligible.has(v.id))
            continue;
        for (const c of cases) {
            for (const model of models) {
                const key = `${v.id}:${c.hash}:${model}`;
                const r = aggregated.get(key);
                if (!r || r.scores.parse < 0.5)
                    continue; // unparseable output isn't worth judging
                cells.push({ key, c, r });
            }
        }
    }
    if (cells.length === 0)
        return;
    const jobs = cells.map((cell) => async () => {
        try {
            const jr = await judgeOutput(cell.r.rawOutput, cell.c, judge);
            cell.r.scores = { ...cell.r.scores, content: jr.score };
            cell.r.judgeJustification = jr.justification;
        }
        catch {
            // Judge failure is non-fatal — keep heuristic content.
        }
    });
    const judgeConcurrency = 3;
    let nextJob = 0;
    const judgeWorker = async () => {
        while (true) {
            const i = nextJob++;
            if (i >= jobs.length)
                return;
            await jobs[i]();
        }
    };
    await Promise.all(Array.from({ length: Math.min(judgeConcurrency, jobs.length) }, judgeWorker));
}
