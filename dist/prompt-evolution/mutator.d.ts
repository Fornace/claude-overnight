/**
 * Prompt mutator — LLM-powered revision of prompts based on failure traces.
 *
 * Pattern: direct HTTP POST (like the librarian) to avoid Agent SDK overhead.
 * The mutator sees:
 *   - The current prompt text
 *   - Concrete failure cases (what the model output, why it was scored down)
 *   - A learning log of past mutations (to avoid retrying failed approaches)
 *   - Sibling variants (for crossover inspiration)
 *
 * Output: a revised prompt + summary of what changed.
 */
import type { MutationRequest, Mutant } from "./types.js";
export interface MutateOpts {
    model: string;
    baseUrl?: string;
    authToken?: string;
    maxTokens?: number;
    timeoutMs?: number;
}
export declare function mutate(request: MutationRequest, opts: MutateOpts): Promise<Mutant>;
