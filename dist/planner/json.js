import { readFileSync } from "fs";
function extractOutermostBraces(text) {
    const start = text.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "{")
            depth++;
        else if (text[i] === "}")
            depth--;
        if (depth === 0)
            return text.slice(start, i + 1);
    }
    return null;
}
export function attemptJsonParse(text) {
    // Strip conversational prefaces/suffixes that weak-schema models sometimes
    // wrap around the JSON body (e.g. "Here is the JSON: { ... } Let me know…").
    const preface = /^\s*(?:Here (?:is|are)[^{]*|Let me[^{]*|I'?ll[^{]*|Sure[^{]*|Okay[^{]*)/i;
    const suffix = /\n\n(?:Let me know|Hope this|Please let me)[\s\S]*$/i;
    if (preface.test(text) || suffix.test(text)) {
        const cleaned = text.replace(preface, "").replace(suffix, "").trim();
        if (cleaned && cleaned !== text) {
            try {
                const obj = JSON.parse(cleaned);
                if (typeof obj === "object" && obj !== null)
                    return obj;
            }
            catch { }
        }
    }
    try {
        const obj = JSON.parse(text);
        if (typeof obj === "object" && obj !== null)
            return obj;
    }
    catch { }
    const braces = extractOutermostBraces(text);
    if (braces) {
        try {
            const obj = JSON.parse(braces);
            if (typeof obj === "object" && obj !== null)
                return obj;
        }
        catch { }
    }
    const stripped = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    if (stripped !== text) {
        try {
            const obj = JSON.parse(stripped);
            if (typeof obj === "object" && obj !== null)
                return obj;
        }
        catch { }
        const b2 = extractOutermostBraces(stripped);
        if (b2) {
            try {
                return JSON.parse(b2);
            }
            catch { }
        }
    }
    const tasksMatch = text.match(/\{\s*"tasks"\s*:\s*\[/);
    if (tasksMatch) {
        const lastBrace = text.lastIndexOf("}");
        if (lastBrace > tasksMatch.index) {
            const salvaged = text.slice(tasksMatch.index, lastBrace + 1) + "]}";
            try {
                const obj = JSON.parse(salvaged);
                if (obj?.tasks?.length > 0)
                    return obj;
            }
            catch { }
        }
    }
    return null;
}
export async function extractTaskJson(raw, retry, onLog, outFile) {
    if (outFile) {
        try {
            const fromFile = attemptJsonParse(readFileSync(outFile, "utf-8"));
            if (fromFile?.tasks)
                return fromFile;
        }
        catch { }
    }
    const first = attemptJsonParse(raw);
    if (first?.tasks)
        return first;
    onLog?.(`Parse failed (${raw.length} chars): ${raw.slice(0, 300)}`);
    const retryText = await retry();
    if (outFile) {
        try {
            const fromFile = attemptJsonParse(readFileSync(outFile, "utf-8"));
            if (fromFile?.tasks)
                return fromFile;
        }
        catch { }
    }
    const second = attemptJsonParse(retryText);
    if (second?.tasks)
        return second;
    onLog?.(`Retry failed (${retryText.length} chars): ${retryText.slice(0, 300)}`);
    throw new Error("Planner did not return valid task JSON after retry");
}
