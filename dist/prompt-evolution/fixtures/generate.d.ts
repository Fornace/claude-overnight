/**
 * LLM-backed benchmark case generator.
 *
 * 10 synthetic cases isn't enough for statistical significance below the
 * 10pp effect-size range — independent sample count is the binding
 * constraint. This module closes that gap by asking an LLM to produce
 * a large, diverse pool of realistic objectives across budget tiers.
 *
 * Generated cases are cached to
 *   $PROMPT_EVOLUTION_STORE/_generated-cases.json
 * so successive runs share the pool (deduplication is hash-based across
 * objective text, not semantic — good enough for our scale).
 *
 * The LLM call is ONE request that returns the full batch (typically
 * ~$0.01-0.05 on Haiku for 50 cases). No recurring cost after the cache
 * is primed.
 */
import type { BenchmarkCase } from "../types.js";
export interface GenerateOpts {
    /** Target total cases (generator runs to top up to this count). */
    targetCount: number;
    /** Model for the generator call. Cheap + JSON-disciplined is ideal (Haiku, GPT-4o-mini). */
    model: string;
    baseUrl?: string;
    authToken?: string;
    /** Prompt path the generated cases will target. */
    promptPath: string;
    /** Cache file location. Defaults to ~/.claude-overnight/prompt-evolution/_generated-cases.json. */
    cachePath?: string;
    /** Existing cases to dedupe against — generator skips objectives overlapping these. */
    existing?: BenchmarkCase[];
}
/**
 * Produce enough generated cases to hit `targetCount`, reading cache first
 * and only calling the LLM if we need more. Returns the full pool (cached
 * plus newly generated), all deduped against `existing`.
 */
export declare function generateCases(opts: GenerateOpts): Promise<BenchmarkCase[]>;
