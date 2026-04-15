// ── Model capability catalog ──
//
// Single source of truth for model capabilities. Update this when new models
// arrive (which happens basically daily). Each entry describes what the model
// can handle in terms of context and task scoping.
//
// contextConstraint:
//   "tight"    — small context window. Model is lazy and error-prone on big
//                tasks. Needs surgical, hyper-specific instructions.
//   "moderate" — decent context. Can handle focused missions but may lose
//                thread on sprawling codebases.
//   "relaxed"  — large context. Can read most of the codebase at once,
//                reliably own multi-file features with autonomy.
export const MODEL_CAPABILITIES = {
    // ── Anthropic Claude 4.5 / 4.6 ──
    "claude-sonnet-4-6": { contextWindow: 256_000, contextConstraint: "relaxed", displayName: "Sonnet 4.6" },
    "claude-sonnet-4-5": { contextWindow: 256_000, contextConstraint: "relaxed", displayName: "Sonnet 4.5" },
    "claude-opus-4-6": { contextWindow: 200_000, contextConstraint: "relaxed", displayName: "Opus 4.6" },
    "claude-opus-4-5": { contextWindow: 200_000, contextConstraint: "relaxed", displayName: "Opus 4.5" },
    "claude-opus-4-20250514": { contextWindow: 200_000, contextConstraint: "relaxed", displayName: "Opus 4" },
    "claude-haiku-4-5": { contextWindow: 200_000, contextConstraint: "moderate", displayName: "Haiku 4.5" },
    "claude-haiku-4-5-20251001": { contextWindow: 200_000, contextConstraint: "moderate", displayName: "Haiku 4.5" },
    // ── Cursor models ──
    "auto": { contextWindow: 256_000, contextConstraint: "relaxed", displayName: "Cursor Auto" },
    "composer-2": { contextWindow: 200_000, contextConstraint: "relaxed", displayName: "Composer 2" },
    "composer-2-fast": { contextWindow: 128_000, contextConstraint: "moderate", displayName: "Composer 2 Fast" },
    "composer": { contextWindow: 128_000, contextConstraint: "moderate", displayName: "Composer" },
    // ── Qwen (via DashScope / custom provider) ──
    "qwen3.6-plus": { contextWindow: 131_072, contextConstraint: "moderate", displayName: "Qwen 3.6 Plus" },
    "qwen3-coder": { contextWindow: 262_144, contextConstraint: "relaxed", displayName: "Qwen 3 Coder" },
    "qwen-max": { contextWindow: 32_768, contextConstraint: "tight", displayName: "Qwen Max" },
    // ── Fallback for unknown models ──
    "unknown": { contextWindow: 128_000, contextConstraint: "moderate" },
};
// ── Default / fallback models ──
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const FALLBACK_MODEL = "claude-opus-4-6"; // used for planner + worker recovery
// ── Lookup ──
/**
 * Find capability info for a model string. Tries: exact match → lowercase
 * exact → substring match. Falls back to "unknown" entry.
 */
export function getModelCapability(model) {
    const m = model.toLowerCase();
    if (MODEL_CAPABILITIES[m])
        return MODEL_CAPABILITIES[m];
    if (MODEL_CAPABILITIES[model])
        return MODEL_CAPABILITIES[model];
    for (const [key, cap] of Object.entries(MODEL_CAPABILITIES)) {
        if (key !== "unknown" && m.includes(key))
            return cap;
    }
    return MODEL_CAPABILITIES.unknown;
}
/** Human-readable model name for display (e.g. in run labels). */
export function modelDisplayName(model) {
    const m = model.toLowerCase();
    // Exact match
    if (MODEL_CAPABILITIES[m]?.displayName)
        return MODEL_CAPABILITIES[m].displayName;
    if (MODEL_CAPABILITIES[model]?.displayName)
        return MODEL_CAPABILITIES[model].displayName;
    // Substring match
    for (const [key, cap] of Object.entries(MODEL_CAPABILITIES)) {
        if (key !== "unknown" && m.includes(key) && cap.displayName)
            return cap.displayName;
    }
    return model;
}
/**
 * Context constraint instruction injected into planner prompts.
 * Tells the planner how to scope tasks based on the worker model's context.
 */
export function contextConstraintNote(model) {
    const cap = getModelCapability(model);
    const ctx = Math.round(cap.contextWindow / 1000);
    switch (cap.contextConstraint) {
        case "tight":
            return `Worker agents have a TIGHT context window (~${ctx}K tokens). They are prone losing thread on large tasks. Be hyper-specific: name exact files, functions, and changes. One narrow deliverable per task. No ambiguity.`;
        case "moderate":
            return `Worker agents have a moderate context window (~${ctx}K tokens). They can handle focused missions but may struggle with sprawling codebases. Be specific about files and expected outcomes. Scope tasks to clear, concrete deliverables.`;
        case "relaxed":
            return `Worker agents have a large context window (~${ctx}K tokens). They can read most of the codebase at once and reliably own multi-file features. Give them missions with full autonomy — "Design and implement X" not "edit line 42 of Y.ts".`;
    }
}
/** Format context window for display (e.g. "256K"). */
export function formatContextWindow(model) {
    const cap = getModelCapability(model);
    if (cap.contextWindow >= 1_000_000)
        return `${(cap.contextWindow / 1_000_000).toFixed(1)}M`;
    return `${Math.round(cap.contextWindow / 1000)}K`;
}
