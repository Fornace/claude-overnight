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
import { VERSION } from "../core/_version.js";

const USER_AGENT = `claude-overnight-evolve/${VERSION}`;

export interface BatchJob {
  customId: string;
  userText: string;
  systemText?: string;
  model: string;
}

export interface BatchOpts {
  baseUrl?: string;
  authToken?: string;
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

export function detectBatchProvider(baseUrl: string | undefined): BatchProvider {
  const url = (baseUrl ?? "https://api.anthropic.com").toLowerCase();
  if (/(^|\/\/)(api\.)?anthropic\.com/.test(url)) return "anthropic";
  // Providers with no batch support — caller auto-falls back to online.
  // - OpenRouter: no batch API at all.
  // - api.kimi.com/coding: Moonshot's coding-specific endpoint; synchronous
  //   only (30 concurrent, 300-1200 req/5hr) with no /v1/files upload flow.
  //   Moonshot's generic platform.moonshot.ai might have batch; this one
  //   doesn't.
  if (/openrouter/.test(url)) return "unsupported";
  if (/(api\.)?kimi\.com\/coding/.test(url)) return "unsupported";
  // Everything else that speaks /v1/chat/completions — OpenAI, DeepSeek,
  // DashScope in OpenAI-compat mode — exposes an OpenAI-compatible batch
  // endpoint we can ride.
  return "openai-compatible";
}

export async function batchCallModel(
  jobs: BatchJob[],
  opts: BatchOpts,
): Promise<Map<string, CallModelResult>> {
  if (jobs.length === 0) return new Map();
  const provider = detectBatchProvider(opts.baseUrl);
  if (provider === "unsupported") {
    throw new Error(`Batch API not supported for baseUrl=${opts.baseUrl}; use online transport`);
  }
  if (provider === "anthropic") return runAnthropicBatch(jobs, opts);
  return runOpenAIBatch(jobs, opts);
}

// ── Anthropic ──────────────────────────────────────────────────────────────

async function runAnthropicBatch(jobs: BatchJob[], opts: BatchOpts): Promise<Map<string, CallModelResult>> {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
    "User-Agent": USER_AGENT,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "message-batches-2024-09-24",
  };

  let batchId = opts.resumeBatchId;
  if (!batchId) {
    const body = JSON.stringify({
      requests: jobs.map((j) => {
        const params: Record<string, unknown> = {
          model: j.model,
          max_tokens: opts.maxTokens ?? 4096,
          messages: [{ role: "user", content: j.userText }],
        };
        if (j.systemText) params.system = j.systemText;
        return { custom_id: j.customId, params };
      }),
    });
    const res = await fetch(`${baseUrl}/v1/messages/batches`, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`Anthropic batch submit: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json() as { id: string };
    batchId = data.id;
    opts.onSubmitted?.(batchId, "anthropic");
  }
  opts.onProgress?.({ provider: "anthropic", batchId, phase: "submitted", total: jobs.length });

  const endedAt = await pollUntilDone(async () => {
    const res = await fetch(`${baseUrl}/v1/messages/batches/${batchId}`, { headers });
    if (!res.ok) throw new Error(`Anthropic batch poll: HTTP ${res.status}`);
    const d = await res.json() as {
      processing_status: "in_progress" | "canceling" | "ended";
      request_counts?: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
      results_url?: string;
    };
    opts.onProgress?.({
      provider: "anthropic",
      batchId: batchId!,
      phase: "polling",
      processing: d.request_counts?.processing,
      succeeded: d.request_counts?.succeeded,
      failed: (d.request_counts?.errored ?? 0) + (d.request_counts?.canceled ?? 0) + (d.request_counts?.expired ?? 0),
      total: jobs.length,
    });
    return d.processing_status === "ended" ? d : null;
  }, opts);

  opts.onProgress?.({ provider: "anthropic", batchId, phase: "downloading" });
  const resultsUrl = (endedAt as { results_url?: string }).results_url ?? `${baseUrl}/v1/messages/batches/${batchId}/results`;
  const res = await fetch(resultsUrl, { headers });
  if (!res.ok) throw new Error(`Anthropic batch results: HTTP ${res.status}`);
  const text = await res.text();

  const out = new Map<string, CallModelResult>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id: string;
      result:
        | { type: "succeeded"; message: { content: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } }
        | { type: "errored"; error: { message: string } }
        | { type: "canceled" | "expired" };
    };
    if (row.result.type === "succeeded") {
      const raw = row.result.message.content.map((c) => c.text ?? "").join("");
      const inp = row.result.message.usage?.input_tokens ?? 0;
      const outp = row.result.message.usage?.output_tokens ?? 0;
      out.set(row.custom_id, { raw, costUsd: (inp * 0.000003 + outp * 0.000015) * 0.5, inputTokens: inp, outputTokens: outp });
    } else {
      const msg = row.result.type === "errored" ? row.result.error.message : row.result.type;
      out.set(row.custom_id, { raw: `batch error: ${msg}`, costUsd: 0, inputTokens: 0, outputTokens: 0 });
    }
  }
  opts.onProgress?.({ provider: "anthropic", batchId, phase: "done", succeeded: out.size, total: jobs.length });
  return out;
}

// ── OpenAI-compatible (OpenAI, Kimi/Moonshot, DeepSeek) ────────────────────

async function runOpenAIBatch(jobs: BatchJob[], opts: BatchOpts): Promise<Map<string, CallModelResult>> {
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
  const authHeaders: Record<string, string> = {
    "Authorization": `Bearer ${authToken}`,
    "User-Agent": USER_AGENT,
  };

  let batchId = opts.resumeBatchId;
  let outputFileId: string | undefined;

  if (!batchId) {
    // Build the JSONL payload and upload as a file.
    const jsonl = jobs.map((j) => {
      const messages: Array<{ role: string; content: string }> = [];
      if (j.systemText) messages.push({ role: "system", content: j.systemText });
      messages.push({ role: "user", content: j.userText });
      return JSON.stringify({
        custom_id: j.customId,
        method: "POST",
        url: "/v1/chat/completions",
        body: { model: j.model, max_tokens: opts.maxTokens ?? 4096, max_completion_tokens: opts.maxTokens ?? 4096, messages },
      });
    }).join("\n");

    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "batch-input.jsonl");
    const fileRes = await fetch(`${baseUrl}/v1/files`, { method: "POST", headers: authHeaders, body: form });
    if (!fileRes.ok) {
      const body = await fileRes.text().catch(() => "");
      throw new Error(`Batch file-upload failed: HTTP ${fileRes.status} at ${baseUrl}/v1/files. ` +
        `This provider may not support OpenAI-compatible batch. Response: ${body.slice(0, 300)}`);
    }
    const fileData = await fileRes.json() as { id: string };

    const createRes = await fetch(`${baseUrl}/v1/batches`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ input_file_id: fileData.id, endpoint: "/v1/chat/completions", completion_window: "24h" }),
    });
    if (!createRes.ok) throw new Error(`OpenAI-compat batch create: HTTP ${createRes.status} ${await createRes.text()}`);
    const createData = await createRes.json() as { id: string };
    batchId = createData.id;
    opts.onSubmitted?.(batchId, "openai-compatible");
  }
  opts.onProgress?.({ provider: "openai-compatible", batchId, phase: "submitted", total: jobs.length });

  const endedAt = await pollUntilDone(async () => {
    const res = await fetch(`${baseUrl}/v1/batches/${batchId}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`OpenAI-compat batch poll: HTTP ${res.status}`);
    const d = await res.json() as {
      status: "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "expired" | "cancelling" | "cancelled";
      request_counts?: { total: number; completed: number; failed: number };
      output_file_id?: string;
      error_file_id?: string;
    };
    opts.onProgress?.({
      provider: "openai-compatible",
      batchId: batchId!,
      phase: "polling",
      succeeded: d.request_counts?.completed,
      failed: d.request_counts?.failed,
      total: d.request_counts?.total ?? jobs.length,
    });
    if (d.status === "completed") return d;
    if (d.status === "failed" || d.status === "expired" || d.status === "cancelled") {
      throw new Error(`OpenAI-compat batch ${d.status}`);
    }
    return null;
  }, opts);

  outputFileId = (endedAt as { output_file_id?: string }).output_file_id;
  if (!outputFileId) throw new Error("OpenAI-compat batch completed with no output_file_id");
  opts.onProgress?.({ provider: "openai-compatible", batchId, phase: "downloading" });

  const contentRes = await fetch(`${baseUrl}/v1/files/${outputFileId}/content`, { headers: authHeaders });
  if (!contentRes.ok) throw new Error(`OpenAI-compat batch download: HTTP ${contentRes.status}`);
  const text = await contentRes.text();

  const out = new Map<string, CallModelResult>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id: string;
      response?: { status_code: number; body: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } };
      error?: { message: string } | null;
    };
    if (row.error || !row.response) {
      out.set(row.custom_id, { raw: `batch error: ${row.error?.message ?? "unknown"}`, costUsd: 0, inputTokens: 0, outputTokens: 0 });
      continue;
    }
    const raw = row.response.body.choices?.[0]?.message?.content ?? "";
    const inp = row.response.body.usage?.prompt_tokens ?? 0;
    const outp = row.response.body.usage?.completion_tokens ?? 0;
    out.set(row.custom_id, { raw, costUsd: (inp * 0.000003 + outp * 0.000015) * 0.5, inputTokens: inp, outputTokens: outp });
  }
  opts.onProgress?.({ provider: "openai-compatible", batchId, phase: "done", succeeded: out.size, total: jobs.length });
  return out;
}

// ── Shared poll loop ───────────────────────────────────────────────────────

async function pollUntilDone<T>(check: () => Promise<T | null>, opts: BatchOpts): Promise<T> {
  const start = Date.now();
  const deadline = start + (opts.batchTimeoutMs ?? 24 * 60 * 60 * 1000);
  let delay = opts.pollStartMs ?? 30_000;
  const maxDelay = opts.pollMaxMs ?? 5 * 60_000;

  while (Date.now() < deadline) {
    const result = await check();
    if (result != null) return result;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(maxDelay, delay * 2);
  }
  throw new Error("Batch exceeded batchTimeoutMs without completing");
}
