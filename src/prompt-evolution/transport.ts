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
  const isKimi = /kimi\.com/i.test(baseUrl);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
  };
  if (isKimi) headers["User-Agent"] = "Kilo-Code/1.0";

  let endpoint: string;
  let body: string;
  if (isAnthropic) {
    endpoint = `${baseUrl}/v1/messages`;
    headers["anthropic-version"] = "2023-06-01";
    const payload: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages: [{ role: "user", content: userText }],
    };
    if (systemText) payload.system = systemText;
    body = JSON.stringify(payload);
  } else {
    endpoint = `${baseUrl}/v1/chat/completions`;
    const messages: Array<{ role: string; content: string }> = [];
    if (systemText) messages.push({ role: "system", content: systemText });
    messages.push({ role: "user", content: userText });
    body = JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
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

/** Strip markdown fences and try hard to find a JSON object in a model output. */
export function attemptJsonParse(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}
