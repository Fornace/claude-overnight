/**
 * Evaluation matrix runner.
 *
 * Given a set of prompt variants and benchmark cases, produces a matrix:
 *   rows    = variants
 *   columns = cases
 *   cells   = EvaluationResult with multi-dimensional scores
 *
 * Uses direct HTTP fetch (not the full Agent SDK) so it's fast and works with
 * any Anthropic-compatible endpoint (OpenRouter, local proxies, etc.).
 */

import { renderPrompt } from "../prompts/load.js";
import { scoreOutput, gmean } from "./scorer.js";
import type { BenchmarkCase, VariantRow, EvaluationResult, PromptVars } from "./types.js";

export interface EvalOpts {
  /** Model to run evaluations with. Should be fast/cheap (haiku, flash, etc.) */
  model: string;
  /** Base URL for the API endpoint */
  baseUrl?: string;
  /** Auth token */
  authToken?: string;
  /** Max tokens per evaluation */
  maxTokens?: number;
  /** Concurrency for parallel case evaluation */
  concurrency?: number;
  /** Optional callback for progress */
  onProgress?: (done: number, total: number, caseName: string, variantId: string) => void;
}

interface EvalJob {
  case: BenchmarkCase;
  variantId: string;
  text: string;
}

export async function buildMatrix(
  variants: Array<{ id: string; promptPath: string; generation: number; text: string }>,
  cases: BenchmarkCase[],
  opts: EvalOpts,
): Promise<VariantRow[]> {
  const jobs: EvalJob[] = [];
  for (const v of variants) {
    for (const c of cases) {
      jobs.push({ case: c, variantId: v.id, text: v.text });
    }
  }

  const concurrency = opts.concurrency ?? 4;
  const results = new Map<string, EvaluationResult>();
  let done = 0;

  // Process in batches
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((job) => runSingle(job, opts)));
    for (const r of batchResults) {
      results.set(`${r.variantId}:${r.caseHash}`, r);
      done++;
      opts.onProgress?.(done, jobs.length, r.caseName, r.variantId);
    }
  }

  // Assemble rows
  const rows: VariantRow[] = [];
  for (const v of variants) {
    const rowResults = new Map<string, EvaluationResult>();
    let parseSum = 0;
    let schemaSum = 0;
    let contentSum = 0;
    let costSum = 0;
    let speedSum = 0;

    for (const c of cases) {
      const r = results.get(`${v.id}:${c.hash}`);
      if (!r) continue;
      rowResults.set(c.hash, r);
      parseSum += r.scores.parse;
      schemaSum += r.scores.schema;
      contentSum += r.scores.content;
      costSum += r.scores.costEfficiency;
      speedSum += r.scores.speed;
    }

    const n = cases.length;
    const aggregate = {
      parse: parseSum / n,
      schema: schemaSum / n,
      content: contentSum / n,
      costEfficiency: costSum / n,
      speed: speedSum / n,
    };

    rows.push({
      variantId: v.id,
      promptPath: v.promptPath,
      generation: v.generation,
      text: v.text,
      results: rowResults,
      aggregate,
      gmean: gmean(aggregate),
    });
  }

  return rows;
}

async function runSingle(job: EvalJob, opts: EvalOpts): Promise<EvaluationResult> {
  const started = Date.now();
  const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";

  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: [{ role: "user", content: job.text }],
  });

  let raw = "";
  let costUsd = 0;

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // Return a zero-score result for HTTP errors so the matrix stays complete
      return makeErrorResult(job, errText, 0, Date.now() - started);
    }

    const data = await res.json() as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    raw = data.content?.map((c) => c.text ?? "").join("") ?? "";

    // Rough cost estimate: $3/M input + $15/M output (claude-3-haiku rates as baseline)
    const inp = data.usage?.input_tokens ?? 0;
    const out = data.usage?.output_tokens ?? 0;
    costUsd = inp * 0.000003 + out * 0.000015;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(job, msg, 0, Date.now() - started);
  }

  const durationMs = Date.now() - started;
  const parsed = attemptJsonParse(raw);
  const scored = scoreOutput(raw, parsed, costUsd, durationMs, job.case);
  scored.variantId = job.variantId;
  return scored;
}

function attemptJsonParse(text: string): unknown {
  // Strip markdown fences and trailing noise
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find the first {…} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function makeErrorResult(job: EvalJob, error: string, costUsd: number, durationMs: number): EvaluationResult {
  return {
    caseHash: job.case.hash,
    caseName: job.case.name,
    variantId: job.variantId,
    promptPath: job.case.promptPath,
    rawOutput: error,
    parsedOutput: null,
    costUsd,
    durationMs,
    scores: { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 },
    notes: [`HTTP/fetch error: ${error.slice(0, 200)}`],
  };
}

/** Render a prompt variant given its source path and optional variant name */
export function renderVariant(promptPath: string, variant: string | undefined, vars: PromptVars): string {
  return renderPrompt(promptPath, { variant, vars });
}
