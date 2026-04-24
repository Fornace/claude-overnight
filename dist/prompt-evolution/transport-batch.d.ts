/**
 * Batch-API transport for prompt evolution.
 *
 * 50% cheaper than online calls on every major provider that supports
 * batch. Perfect fit for generations=1 benchmark rounds where interactive
 * progress isn't needed — we submit 120-1000 requests, poll every 30-300s,
 * then pull the results in one shot.
 *
 * Provider detection from baseUrl:
 *   - api.anthropic.com → Anthropic Message Batches API (one-shot submit)
 *   - kimi / moonshot / openai → OpenAI-compatible file-based batch
 *   - openrouter → NO batch support; throws (caller must fall back to online)
 *
 * Custom IDs route results back to the right (variant, case, model, rep)
 * cell. The evaluator builds ids like `v0:h_abc:kimi-for-coding:r0`.
 *
 * Poll state is persisted via `persistBatchState` so a crashed or
 * restarted run can resume without resubmitting.
 */
import type { CallModelResult } from "./transport.js";
export interface BatchJob {
    customId: string;
    userText: string;
    systemText?: string;
    model: string;
}
export interface BatchOpts {
    baseUrl?: string;
    authToken?: string;
    /**
     * Override model for the batch submission. Moonshot's batch API only
     * accepts kimi-k2.5 or kimi-k2.6 — NOT the kimi-for-coding alias that the
     * coding endpoint uses. When batch is enabled against a Kimi stack, set
     * this so online eval keeps using kimi-for-coding while batch uses the
     * concrete version.
     */
    modelOverride?: string;
    maxTokens?: number;
    /** Poll interval starts here and doubles to `pollMaxMs`. Defaults 30s → 5min. */
    pollStartMs?: number;
    pollMaxMs?: number;
    /** Overall timeout for the whole batch. Default 24h — matches provider SLAs. */
    batchTimeoutMs?: number;
    /** Called with progress snapshots during polling. */
    onProgress?: (p: BatchProgress) => void;
    /** Restore a previously-submitted batch instead of resubmitting. */
    resumeBatchId?: string;
    /** Called after submit returns an id — use to persist for crash resume. */
    onSubmitted?: (batchId: string, provider: BatchProvider) => void;
}
export interface BatchProgress {
    provider: BatchProvider;
    batchId: string;
    phase: "submitted" | "polling" | "downloading" | "done";
    processing?: number;
    succeeded?: number;
    failed?: number;
    total?: number;
}
export type BatchProvider = "anthropic" | "openai-compatible" | "unsupported";
export declare function detectBatchProvider(baseUrl: string | undefined): BatchProvider;
export declare function batchCallModel(jobs: BatchJob[], opts: BatchOpts): Promise<Map<string, CallModelResult>>;
