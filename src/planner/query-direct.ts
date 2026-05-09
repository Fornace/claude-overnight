// Direct HTTP bypass for non-Anthropic endpoints.
//
// The Claude Code CLI subprocess spawned by `@anthropic-ai/claude-agent-sdk`
// validates model names against its built-in Anthropic list and rejects custom
// ids (qwen3.6-plus, composer-2, …) pre-flight, even when ANTHROPIC_BASE_URL
// points at an Anthropic-compatible proxy. Bypass the SDK with a direct POST
// for any non-anthropic.com base.

import type { PlannerOpts } from "./query.js";
import type { PlannerLog } from "./throttle.js";
import { cursorProxyRateLimiter, apiEndpointLimiter } from "../core/rate-limiter.js";
import { sleep } from "../swarm/errors.js";

const MAX_RETRIES = 3;
const BACKOFF = [30_000, 60_000, 120_000];

export function shouldUseDirectFetch(env: Record<string, string> | undefined): boolean {
  const base = env?.ANTHROPIC_BASE_URL;
  if (!base) return false;
  return !/^https?:\/\/(api\.)?anthropic\.com/i.test(base);
}

export async function runViaDirectFetch(
  prompt: string, opts: PlannerOpts, env: Record<string, string> | undefined, onLog: PlannerLog,
): Promise<string> {
  const baseUrl = (env?.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
  const authToken = env?.ANTHROPIC_AUTH_TOKEN ?? "";
  const rl = cursorProxyRateLimiter;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Wait out both budgets — the retry loop catches HTTP 429s but not our own
    // RateLimitError, so hard-asserting would abort the whole fetch path.
    await apiEndpointLimiter.waitIfNeeded();
    const waited = await rl.waitIfNeeded();
    if (waited > 0) onLog(`Planner proxy rate gate — waited ${Math.round(waited / 1000)}s`, "event");
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: opts.model, max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitMs = BACKOFF[attempt];
      onLog(`Planner proxy rate limited — waiting ${Math.round(waitMs / 1000)}s`, "event");
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) throw new Error(`Planner proxy ${res.status}: ${(await res.text().catch(() => ""))}`);
    rl.record();
    apiEndpointLimiter.record();
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? "";
  }
  throw new Error("Planner proxy direct fetch failed after retries");
}
