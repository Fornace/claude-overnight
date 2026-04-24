/**
 * HTTP transport for prompt-evolution evaluations.
 *
 * Extracted so evaluator.ts can be tested without real network calls —
 * the discrimination test injects a mock `callModel` to verify that the
 * scorer + matrix pipeline actually discriminates good prompts from bad.
 *
 * Supports both Anthropic-native and OpenAI-compatible endpoints so we can
 * run the same eval against Haiku, Kimi, and OpenRouter without a rewrite.
 */
export interface CallModelOpts {
    model: string;
    baseUrl?: string;
    authToken?: string;
    maxTokens?: number;
    timeoutMs?: number;
}
export interface CallModelResult {
    raw: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
}
/** Injectable model call — default is `defaultCallModel`; tests pass a mock. */
export type CallModel = (userText: string, systemText: string | undefined, opts: CallModelOpts) => Promise<CallModelResult>;
export declare function defaultCallModel(userText: string, systemText: string | undefined, opts: CallModelOpts): Promise<CallModelResult>;
/**
 * Strip markdown fences, strip preamble, and try to find a JSON value.
 *
 * Handles both `{…}` objects and `[…]` arrays — the previous implementation
 * missed arrays entirely, which broke the case generator (Kimi returns the
 * case list as a top-level array that's often preceded by a one-line
 * preamble even when instructed otherwise).
 */
export declare function attemptJsonParse(text: string): unknown;
