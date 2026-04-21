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
export async function buildMatrix(variants, cases, opts) {
    const jobs = [];
    for (const v of variants) {
        for (const c of cases) {
            jobs.push({ case: c, variantId: v.id, text: v.text, systemText: c.systemPrompt });
        }
    }
    const concurrency = opts.concurrency ?? 4;
    const results = new Map();
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
    const rows = [];
    for (const v of variants) {
        const rowResults = new Map();
        let parseSum = 0;
        let schemaSum = 0;
        let contentSum = 0;
        let costSum = 0;
        let speedSum = 0;
        for (const c of cases) {
            const r = results.get(`${v.id}:${c.hash}`);
            if (!r)
                continue;
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
async function runSingle(job, opts) {
    const started = Date.now();
    const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
    const isAnthropic = /^https?:\/\/(api\.)?anthropic\.com/i.test(baseUrl);
    const isKimi = /kimi\.com/i.test(baseUrl);
    let body;
    let endpoint;
    let headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
    };
    if (isKimi)
        headers["User-Agent"] = "Kilo-Code/1.0";
    if (isAnthropic) {
        // Anthropic native format
        endpoint = `${baseUrl}/v1/messages`;
        headers["anthropic-version"] = "2023-06-01";
        const messages = [{ role: "user", content: job.text }];
        const payload = {
            model: opts.model,
            max_tokens: opts.maxTokens ?? 4096,
            messages,
        };
        if (job.systemText)
            payload.system = job.systemText;
        body = JSON.stringify(payload);
    }
    else {
        // OpenAI-compatible format (OpenRouter, local proxies, etc.)
        endpoint = `${baseUrl}/v1/chat/completions`;
        const messages = [];
        if (job.systemText) {
            messages.push({ role: "system", content: job.systemText });
        }
        messages.push({ role: "user", content: job.text });
        body = JSON.stringify({
            model: opts.model,
            max_tokens: opts.maxTokens ?? 4096,
            messages,
        });
    }
    let raw = "";
    let costUsd = 0;
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body,
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            return makeErrorResult(job, errText, 0, Date.now() - started);
        }
        let inp = 0;
        let out = 0;
        if (isAnthropic) {
            const data = await res.json();
            raw = data.content?.map((c) => c.text ?? "").join("") ?? "";
            inp = data.usage?.input_tokens ?? 0;
            out = data.usage?.output_tokens ?? 0;
        }
        else {
            const data = await res.json();
            raw = data.choices?.[0]?.message?.content ?? "";
            inp = data.usage?.prompt_tokens ?? 0;
            out = data.usage?.completion_tokens ?? 0;
        }
        // Rough cost estimate: varies by model. Using claude-3-haiku as baseline.
        costUsd = inp * 0.000003 + out * 0.000015;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeErrorResult(job, msg, 0, Date.now() - started);
    }
    const durationMs = Date.now() - started;
    const parsed = attemptJsonParse(raw);
    const scored = scoreOutput(raw, parsed, costUsd, durationMs, job.case);
    scored.variantId = job.variantId;
    return scored;
}
function attemptJsonParse(text) {
    // Strip markdown fences and trailing noise
    const cleaned = text
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
    try {
        return JSON.parse(cleaned);
    }
    catch {
        // Try to find the first {…} block
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                return JSON.parse(m[0]);
            }
            catch {
                return null;
            }
        }
        return null;
    }
}
function makeErrorResult(job, error, costUsd, durationMs) {
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
export function renderVariant(promptPath, variant, vars) {
    return renderPrompt(promptPath, { variant, vars });
}
