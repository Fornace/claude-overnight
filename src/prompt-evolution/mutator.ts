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

import { renderPrompt } from "../prompts/load.js";
import type { MutationRequest, Mutant, FailureTrace, LearningEntry } from "./types.js";

export interface MutateOpts {
  model: string;
  baseUrl?: string;
  authToken?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function mutate(request: MutationRequest, opts: MutateOpts): Promise<Mutant> {
  const prompt = buildMutatorPrompt(request);
  const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
  const isKimi = /kimi\.com/i.test(baseUrl);

  let body: string;
  if (baseUrl.includes("generativelanguage")) {
    body = JSON.stringify({
      model: opts.model,
      max_completion_tokens: opts.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    });
  } else {
    body = JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
    "anthropic-version": "2023-06-01",
    "User-Agent": "Claude-Code/0.1.0",
  };

  let endpoint = `${baseUrl}/v1/messages`;
  if (baseUrl.includes("generativelanguage")) {
    endpoint = `${baseUrl}/v1/chat/completions`;
  } else if (!/^https?:\/\/(api\.)?anthropic\.com/i.test(baseUrl) && !baseUrl.includes("/v1/messages")) {
     // A lot of OpenAI compatible endpoints use `/v1/chat/completions` natively
     endpoint = `${baseUrl}/v1/chat/completions`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mutator HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { content?: Array<{ text?: string }> };
  let raw = "";
  if (endpoint.includes("chat/completions")) {
    const chatData = data as { choices?: Array<{ message?: { content?: string } }> };
    raw = chatData.choices?.[0]?.message?.content ?? "";
  } else {
    const msgData = data as { content?: Array<{ text?: string }> };
    raw = msgData.content?.map((c) => c.text ?? "").join("") ?? "";
  }

  return parseMutantOutput(raw, request);
}

function buildMutatorPrompt(req: MutationRequest): string {
  const failures = req.failures
    .map((f, i) => {
      const scores = Object.entries(f.scores)
        .map(([k, v]) => `  ${k}: ${(v * 100).toFixed(0)}%`)
        .join("\n");
      return `Failure ${i + 1}: ${f.caseName}\nScores:\n${scores}\nNotes: ${f.notes.join("; ") || "none"}\nRaw output excerpt:\n${f.rawOutput.slice(0, 800)}`;
    })
    .join("\n\n---\n\n");

  const learning = req.learningLog.length
    ? req.learningLog
        .map((l) => `Gen ${l.generation}: ${l.mutationSummary} → ${l.status} (Δ ${(l.fitnessDelta * 100).toFixed(1)}%)`)
        .join("\n")
    : "(none yet)";

  const siblings = req.siblingTexts.length
    ? req.siblingTexts.map((t, i) => `Sibling ${i + 1}:\n${t.slice(0, 600)}`).join("\n\n---\n\n")
    : "(none)";

  return `You are a prompt engineer specializing in improving LLM system prompts.

Your job: revise the CURRENT PROMPT below so that it performs better on the failure cases.

Rules:
- Keep the same general purpose and structure.
- Be surgical: change only what's needed to fix the failures.
- Do not add fluff or generic advice.
- If a sibling prompt handles a failure case well, borrow its technique (crossover).
- Do NOT retry approaches listed in the LEARNING LOG that previously regressed.
- Output ONLY the revised prompt inside a markdown code fence, followed by a one-line summary.

---

CURRENT PROMPT (target: ${req.promptPath}):
\`\`\`
${req.currentText}
\`\`\`

---

FAILURE CASES:
${failures}

---

LEARNING LOG (do not repeat failed approaches):
${learning}

---

SIBLING VARIANTS (borrow techniques that work):
${siblings}

---

Respond in this exact format:

\`\`\`
(revised prompt text here, exactly as it should be sent to the model)
\`\`\`

Summary: (one sentence describing what you changed and why)
`;
}

function parseMutantOutput(raw: string, req: MutationRequest): Mutant {
  const codeFence = raw.match(/```\n?([\s\S]*?)\n?```/);
  const text = codeFence ? codeFence[1].trim() : raw.trim();

  const summaryMatch = raw.match(/Summary:\s*(.+)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : "(no summary)";

  // Stable ID from parent + summary hash
  const idSeed = `${req.currentText.length}:${summary}:${Date.now()}`;
  const id = hashSeed(idSeed).slice(0, 8);

  return {
    variantId: `evo-${id}`,
    text,
    generation: 0, // caller fills
    parentId: "", // caller fills
    mutationSummary: summary,
  };
}

function hashSeed(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
