import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Resolve <pkg>/prompts whether running from dist/ (installed) or src/ (dev).
export const PROMPTS_ROOT = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const depth of [2, 3, 4]) {
        const candidate = join(here, ...Array(depth).fill(".."), "prompts");
        if (existsSync(join(candidate, "_shared", "design-thinking.md")))
            return candidate;
    }
    throw new Error("prompts/ directory not found relative to " + here);
})();
const cache = new Map();
function readRaw(rel) {
    let text = cache.get(rel);
    if (text === undefined) {
        text = readFileSync(join(PROMPTS_ROOT, rel + ".md"), "utf-8");
        cache.set(rel, text);
    }
    return text;
}
function stripFrontmatter(t) {
    if (!t.startsWith("---\n"))
        return t;
    const end = t.indexOf("\n---\n", 4);
    return end === -1 ? t : t.slice(end + 5);
}
function pickVariant(t, name) {
    const want = name.toUpperCase();
    for (const section of t.split(/\n<!--\s*@@@\s*-->\n/)) {
        const m = section.match(/<!--\s*(?:[─\-]+\s*)?([A-Z][A-Z0-9_\-]*)/);
        if (m && m[1].toUpperCase() === want)
            return section;
    }
    throw new Error(`Prompt variant "${name}" not found`);
}
function applyTemplate(t, vars) {
    // Partial includes — render verbatim, no template processing on the partial body
    // beyond stripping its frontmatter and surface comments.
    return t
        .replace(/\{\{>\s*([\w./-]+)\s*\}\}/g, (_, p) => stripFrontmatter(readRaw(p)).replace(/<!--[\s\S]*?-->/g, "").trim())
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
        const v = vars[key];
        return v !== undefined && v !== null && v !== false && v !== "" && v !== 0 ? body : "";
    })
        .replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const v = vars[key];
        return v === undefined || v === null ? "" : String(v);
    })
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
export function renderPrompt(file, opts = {}) {
    let t = stripFrontmatter(readRaw(file));
    if (opts.variant)
        t = pickVariant(t, opts.variant);
    return applyTemplate(t, opts.vars ?? {});
}
