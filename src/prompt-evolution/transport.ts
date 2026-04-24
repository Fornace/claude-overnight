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

import { VERSION } from "../core/_version.js";

const USER_AGENT = `claude-overnight-evolve/${VERSION}`;

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
export type CallModel = (
  userText: string,
  systemText: string | undefined,
  opts: CallModelOpts,
) => Promise<CallModelResult>;

export async function defaultCallModel(
  userText: string,
  systemText: string | undefined,
  opts: CallModelOpts,
): Promise<CallModelResult> {
  const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
  const isAnthropic = /^https?:\/\/(api\.)?anthropic\.com/i.test(baseUrl);

  // Identify ourselves honestly. Kimi's coding-endpoint docs explicitly say
  // "Tampering with the client identifier (User-Agent) is considered a
  // violation." The previous "Kilo-Code/1.0" was impersonating a third-party
  // tool; we now send our real binary name + version.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
    "User-Agent": USER_AGENT,
  };

  const maxOut = opts.maxTokens ?? 4096;

  let endpoint: string;
  let body: string;
  if (isAnthropic) {
    endpoint = `${baseUrl}/v1/messages`;
    headers["anthropic-version"] = "2023-06-01";
    const payload: Record<string, unknown> = {
      model: opts.model,
      max_tokens: maxOut, // Anthropic uses max_tokens, not max_completion_tokens.
      messages: [{ role: "user", content: userText }],
    };
    if (systemText) payload.system = systemText;
    body = JSON.stringify(payload);
  } else {
    endpoint = `${baseUrl}/v1/chat/completions`;
    const messages: Array<{ role: string; content: string }> = [];
    if (systemText) messages.push({ role: "system", content: systemText });
    messages.push({ role: "user", content: userText });
    // Platform.moonshot.ai marks max_tokens deprecated in favor of
    // max_completion_tokens. Kimi's coding endpoint still accepts max_tokens.
    // Sending both is safe — OpenAI, Moonshot, DeepSeek, and Kimi all tolerate
    // the extra field, and we're future-proof against the deprecation.
    body = JSON.stringify({
      model: opts.model,
      max_tokens: maxOut,
      max_completion_tokens: maxOut,
      messages,
    });
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  let raw = "";
  let inputTokens = 0;
  let outputTokens = 0;
  if (isAnthropic) {
    const data = await res.json() as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    raw = data.content?.map((c) => c.text ?? "").join("") ?? "";
    inputTokens = data.usage?.input_tokens ?? 0;
    outputTokens = data.usage?.output_tokens ?? 0;
  } else {
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    raw = data.choices?.[0]?.message?.content ?? "";
    inputTokens = data.usage?.prompt_tokens ?? 0;
    outputTokens = data.usage?.completion_tokens ?? 0;
  }

  // Rough cost using claude-3-haiku pricing as baseline; real per-model pricing
  // lives in billing, this is only used for relative ordering on speed/cost dims.
  const costUsd = inputTokens * 0.000003 + outputTokens * 0.000015;
  return { raw, costUsd, inputTokens, outputTokens };
}

/**
 * Strip markdown fences, strip preamble, and try to find a JSON value.
 *
 * Handles both `{…}` objects and `[…]` arrays — the previous implementation
 * missed arrays entirely, which broke the case generator (Kimi returns the
 * case list as a top-level array that's often preceded by a one-line
 * preamble even when instructed otherwise).
 */
export function attemptJsonParse(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try the first plausible JSON value — object OR array, whichever comes
    // first in the text. We build a regex union and pick the earliest match.
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const candidates: Array<{ idx: number; text: string }> = [];
    if (objMatch && objMatch.index != null) candidates.push({ idx: objMatch.index, text: objMatch[0] });
    if (arrMatch && arrMatch.index != null) candidates.push({ idx: arrMatch.index, text: arrMatch[0] });
    candidates.sort((a, b) => a.idx - b.idx);
    for (const c of candidates) {
      try { return JSON.parse(c.text); } catch { /* try next */ }
    }
    return null;
  }
}
