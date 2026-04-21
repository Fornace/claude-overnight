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
import type { VariantRow, CuratorDecision } from "./types.js";
export interface CurateOpts {
    /** Number of top variants to keep (elite) */
    eliteCount?: number;
    /** Number of additional diverse variants to keep via novelty */
    diversityCount?: number;
    /** Minimum gmean improvement over current canon to promote */
    promoteThreshold?: number;
}
export declare function curate(rows: VariantRow[], currentCanonGmean: number, opts?: CurateOpts): CuratorDecision;
/** Pretty-print a matrix for human review */
export declare function formatMatrix(rows: VariantRow[], caseNames: string[]): string;
