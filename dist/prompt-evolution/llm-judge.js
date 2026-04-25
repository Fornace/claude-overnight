/**
 * LLM-as-judge scoring for prompt evolution.
 *
 * Inspired by Hermes Agent's autoresearch skill and self-evolution repo:
 *   - Structured rubric (5 criteria × 1-5 scale, normalised to 0-1)
 *   - The judge sees the prompt, the case, and the model's raw output
 *   - Returns both a scalar score and human-readable justification
 *
 * When to use:
 *   - Content criteria that are too fuzzy for deterministic regex
 *     (e.g. "was the plan creative?", "did the response follow the spirit of the prompt?")
 *   - Final validation gate before promoting a variant to canon
 *
 * Cost: ~1 judge call per case per generation (~$0.002-0.01 each).
 */
const DEFAULT_RUBRIC = [
    { name: "parse", question: "Is the output well-formed and parseable (valid JSON if expected, clear structure otherwise)?" },
    { name: "schema", question: "Does the output contain all required fields / follow the expected schema?" },
    { name: "content", question: "Is the content accurate, relevant, and satisfying the user's intent?" },
    { name: "concision", question: "Is the response concise without omitting necessary detail?" },
    { name: "instruction", question: "Does the output follow the explicit and implicit instructions in the system prompt?" },
];
/**
 * Score a single (case, output) pair with an LLM judge.
 *
 * The judge prompt is carefully structured to be reproducible:
 *   - Exact rubric with 1-5 Likert scale definitions
 *   - One-shot example in the prompt text
 *   - Forced JSON output schema
 */
export async function judgeOutput(rawOutput, c, opts) {
    const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
    const isKimi = /kimi\.com/i.test(baseUrl);
    const prompt = buildJudgePrompt(rawOutput, c);
    const body = JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2048,
        messages: [{ role: "user", content: prompt }],
    });
    const isAnthropic = /^https?:\/\/(api\.)?anthropic\.com/i.test(baseUrl);
    const endpoint = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;
    const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
        "User-Agent": "Claude-Code/0.1.0",
    };
    if (isAnthropic)
        headers["anthropic-version"] = "2023-06-01";
    const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Judge HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let raw = "";
    if (isAnthropic) {
        const data = await res.json();
        raw = data.content?.map((c) => c.text ?? "").join("") ?? "";
    }
    else {
        const data = await res.json();
        raw = data.choices?.[0]?.message?.content ?? "";
    }
    return parseJudgeOutput(raw);
}
export function buildJudgePrompt(rawOutput, c) {
    const rubricLines = DEFAULT_RUBRIC
        .map((r, i) => `${i + 1}. **${r.name}**: ${r.question}`)
        .join("\n");
    return `You are an expert prompt-evaluation judge. Your task is to score a language-model output against a benchmark case using a strict rubric.

## Benchmark Case

- **Name**: ${c.name}
- **Prompt path**: ${c.promptPath}
- **Expected criteria**:
${Object.entries(c.criteria).map(([k, v]) => `  - ${k}: ${v}`).join("\n")}

## Model Output

\`\`\`
${rawOutput.slice(0, 3000)}
\`\`\`

## Rubric

Score each criterion on a 1-5 Likert scale:
- 5 = Excellent / exceeds expectations
- 4 = Good / meets expectations
- 3 = Acceptable / minor issues
- 2 = Poor / significant issues
- 1 = Unacceptable / fails completely

${rubricLines}

## Response Format

Respond ONLY with a JSON object in this exact shape (no markdown fences, no extra text):

{"parse":5,"schema":5,"content":4,"concision":4,"instruction":5,"justification":"Brief justification here."}
`;
}
export function parseJudgeOutput(raw) {
    // Strip fences
    const cleaned = raw
        .replace(/^\`\`\`(?:json)?\s*\n?/i, "")
        .replace(/\n?\`\`\`\s*$/i, "")
        .trim();
    let obj;
    try {
        obj = JSON.parse(cleaned);
    }
    catch {
        // Try to extract first JSON object
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) {
            return { score: 0.5, dimensions: {}, justification: "Judge returned unparseable JSON. Falling back to neutral." };
        }
        try {
            obj = JSON.parse(m[0]);
        }
        catch {
            return { score: 0.5, dimensions: {}, justification: "Judge returned unparseable JSON. Falling back to neutral." };
        }
    }
    const getNum = (k) => {
        const v = obj[k];
        if (typeof v === "number")
            return Math.max(1, Math.min(5, v));
        return 3; // neutral default
    };
    const parse = (getNum("parse") - 1) / 4;
    const schema = (getNum("schema") - 1) / 4;
    const content = (getNum("content") - 1) / 4;
    const concision = (getNum("concision") - 1) / 4;
    const instruction = (getNum("instruction") - 1) / 4;
    // Map concision → costEfficiency, instruction → speed (proxy for "follows instructions quickly")
    const dimensions = {
        parse,
        schema,
        content,
        costEfficiency: concision,
        speed: instruction,
    };
    const vals = [parse, schema, content, concision, instruction];
    const score = vals.reduce((a, b) => a + b, 0) / vals.length;
    return {
        score,
        dimensions,
        justification: typeof obj.justification === "string" ? obj.justification : "(no justification)",
    };
}
