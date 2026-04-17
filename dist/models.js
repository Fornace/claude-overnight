// ── Model capability catalog ──
//
// Single source of truth for model capabilities. Update this when new models
// arrive (which happens basically daily). Each entry describes what the model
// can handle in terms of context and task scoping.
//
// contextWindow   — declared/advertised context (shown in UI)
// safeContext     — conservative usable context ≤40% of declared, adjusted for
//                   model quality. This is what planners use to scope tasks.
//                   Based on: RULER benchmarks, "lost in the middle" research,
//                   Chroma context-rot studies, and real-world experience.
//
// contextConstraint — combines usable context AND model laziness/diligence:
//   "tight"    — lazy or small context. Needs surgical, hyper-specific tasks.
//   "moderate" — decent. Focused missions with clear targets.
//   "relaxed"  — large usable context + low laziness. Full autonomy.
//
// Laziness source: IFEval scores, Ian Paterson 38-task routing benchmark,
// Chroma hallucination study. "relaxed" = 95%+ on all three axes.
export const MODEL_CAPABILITIES = {
    // ── Anthropic Claude (Apr 2026) ──
    // Opus 4.7: only model that earns "relaxed". 100% on 38-task routing, 95%+ IFEval.
    // Step-change agentic coding over Opus 4.6. 1M tokens, 128K output.
    "claude-opus-4-7": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7" },
    "claude-opus-4-7-low": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "moderate", displayName: "Opus 4.7 Low" },
    "claude-opus-4-7-medium": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Medium" },
    "claude-opus-4-7-high": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 High" },
    "claude-opus-4-7-xhigh": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Extra High" },
    "claude-opus-4-7-max": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Max" },
    "claude-opus-4-7-thinking": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Thinking" },
    "claude-opus-4-7-thinking-low": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "moderate", displayName: "Opus 4.7 Low Thinking" },
    "claude-opus-4-7-thinking-medium": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Medium Thinking" },
    "claude-opus-4-7-thinking-high": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 High Thinking" },
    "claude-opus-4-7-thinking-xhigh": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Extra High Thinking" },
    "claude-opus-4-7-thinking-max": { contextWindow: 1_000_000, safeContext: 400_000, contextConstraint: "relaxed", displayName: "Opus 4.7 Max Thinking" },
    // Sonnet 4.6: 200K context, tight constraint.
    "claude-sonnet-4-6": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "tight", displayName: "Sonnet 4.6" },
    "claude-4.6-sonnet-medium": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "tight", displayName: "Sonnet 4.6 Medium" },
    "claude-sonnet-4-6-thinking": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "tight", displayName: "Sonnet 4.6 Thinking" },
    "claude-4.6-sonnet-medium-thinking": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "tight", displayName: "Sonnet 4.6 Medium Thinking" },
    // Sonnet 4.5: 200K context.
    "claude-sonnet-4-5": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4.5" },
    "claude-4.5-sonnet": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4.5" },
    "claude-sonnet-4-5-thinking": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4.5 Thinking" },
    "claude-4.5-sonnet-thinking": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4.5 Thinking" },
    // Claude 4 Opus/Sonnet (original): deprecated June 2026. 200K context.
    "claude-opus-4": { contextWindow: 200_000, safeContext: 80_000, contextConstraint: "moderate", displayName: "Opus 4.0" },
    "claude-sonnet-4": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4.0" },
    "claude-4-sonnet": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4" },
    "claude-4-sonnet-1m": { contextWindow: 1_000_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "Sonnet 4 1M" },
    "claude-sonnet-4-thinking": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4 Thinking" },
    "claude-4-sonnet-thinking": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Sonnet 4 Thinking" },
    "claude-4-sonnet-1m-thinking": { contextWindow: 1_000_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "Sonnet 4 1M Thinking" },
    // Haiku 4.5: cheapest Claude. 200K context, near-frontier smarts.
    "claude-haiku-4-5": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Haiku 4.5" },
    "claude-haiku-4-5-20251001": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Haiku 4.5" },
    "claude-haiku-4-6": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Haiku 4.6" },
    "claude-haiku-4": { contextWindow: 200_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Haiku 4" },
    // ── OpenAI (Apr 2026 — GPT-4.1/o3/o4-mini retired Feb 2026) ──
    // GPT-5.4: current flagship. 1M context, 128K output. Good but literal.
    "gpt-5.4": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4" },
    "gpt-5.4-low": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 Low" },
    "gpt-5.4-medium": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 Medium" },
    "gpt-5.4-medium-fast": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 Fast" },
    "gpt-5.4-high": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 High" },
    "gpt-5.4-high-fast": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 High Fast" },
    "gpt-5.4-xhigh": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 Extra High" },
    "gpt-5.4-xhigh-fast": { contextWindow: 1_050_000, safeContext: 300_000, contextConstraint: "moderate", displayName: "GPT-5.4 Extra High Fast" },
    "gpt-5.4-mini": { contextWindow: 1_050_000, safeContext: 200_000, contextConstraint: "tight", displayName: "GPT-5.4 Mini" },
    "gpt-5.4-mini-low": { contextWindow: 1_050_000, safeContext: 200_000, contextConstraint: "tight", displayName: "GPT-5.4 Mini Low" },
    "gpt-5.4-mini-medium": { contextWindow: 1_050_000, safeContext: 200_000, contextConstraint: "tight", displayName: "GPT-5.4 Mini Medium" },
    "gpt-5.4-mini-high": { contextWindow: 1_050_000, safeContext: 200_000, contextConstraint: "tight", displayName: "GPT-5.4 Mini High" },
    "gpt-5.4-mini-xhigh": { contextWindow: 1_050_000, safeContext: 200_000, contextConstraint: "tight", displayName: "GPT-5.4 Mini Extra High" },
    // Codex 5.3: best agentic coder from OpenAI. 400K context, 128K output.
    "gpt-5.3-codex": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.3" },
    "gpt-5.3-codex-low": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.3 Low" },
    "gpt-5.3-codex-high": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.3 High" },
    "gpt-5.3-codex-xhigh": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.3 Extra High" },
    "gpt-5.3-codex-fast": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.3 Fast" },
    // Older OpenAI
    "gpt-5.2": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "GPT-5.2" },
    "gpt-5.2-codex": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.2" },
    "gpt-5.1": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "GPT-5.1" },
    "gpt-5": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "GPT-5" },
    "gpt-5.1-codex-mini": { contextWindow: 400_000, safeContext: 160_000, contextConstraint: "moderate", displayName: "Codex 5.1 Mini" },
    // ── Google Gemini 3 (Apr 2026 — Gemini 2.5 deprecated June 2026) ──
    // Large context but terrible at agentic coding: 13.5% SWE-bench (vs Sonnet 31.2%).
    // Good for reading lots of code, bad at following through. Needs surgical tasks.
    "gemini-3.1-pro": { contextWindow: 1_000_000, safeContext: 350_000, contextConstraint: "tight", displayName: "Gemini 3.1 Pro" },
    "gemini-3-pro": { contextWindow: 1_000_000, safeContext: 350_000, contextConstraint: "tight", displayName: "Gemini 3 Pro" },
    // Flash: 8.2% SWE-bench. Essentially unusable for autonomous agent work.
    "gemini-3-flash": { contextWindow: 1_000_000, safeContext: 250_000, contextConstraint: "tight", displayName: "Gemini 3 Flash" },
    // ── xAI Grok ──
    "grok-4-20": { contextWindow: 256_000, safeContext: 80_000, contextConstraint: "moderate", displayName: "Grok 4.20" },
    "grok-4-20-thinking": { contextWindow: 256_000, safeContext: 80_000, contextConstraint: "moderate", displayName: "Grok 4.20 Thinking" },
    // ── Moonshot ──
    "kimi-k2.5": { contextWindow: 128_000, safeContext: 40_000, contextConstraint: "tight", displayName: "Kimi K2.5" },
    // ── DeepSeek V3.2 (Apr 2026 — V3/R1 superseded, V4 not yet out) ──
    "deepseek-chat": { contextWindow: 128_000, safeContext: 40_000, contextConstraint: "tight", displayName: "DeepSeek V3.2" },
    "deepseek-reasoner": { contextWindow: 128_000, safeContext: 45_000, contextConstraint: "moderate", displayName: "DeepSeek V3.2 Reasoner" },
    // ── Meta Llama 4 (Apr 2025 — still latest open-weight) ──
    // Scout: claims 10M via iRoPE, providers cap at ~327K. No independent validation.
    "llama-4-scout": { contextWindow: 327_680, safeContext: 80_000, contextConstraint: "moderate", displayName: "Llama 4 Scout" },
    "llama-4-maverick": { contextWindow: 1_000_000, safeContext: 100_000, contextConstraint: "moderate", displayName: "Llama 4 Maverick" },
    // ── Cursor models (opaque routing) ──
    "auto": { contextWindow: 256_000, safeContext: 60_000, contextConstraint: "moderate", displayName: "Cursor Auto" },
    "composer-2": { contextWindow: 200_000, safeContext: 40_000, contextConstraint: "tight", displayName: "Composer 2" },
    "composer-2-fast": { contextWindow: 200_000, safeContext: 40_000, contextConstraint: "tight", displayName: "Composer 2 Fast" },
    "composer": { contextWindow: 128_000, safeContext: 30_000, contextConstraint: "tight", displayName: "Composer" },
    "composer-1.5": { contextWindow: 128_000, safeContext: 30_000, contextConstraint: "tight", displayName: "Composer 1.5" },
    // ── Qwen (Apr 2026 — qwen3.6-plus is newest flagship) ──
    "qwen3.6-plus": { contextWindow: 1_000_000, safeContext: 200_000, contextConstraint: "moderate", displayName: "Qwen 3.6 Plus" },
    "qwen3-coder-plus": { contextWindow: 1_000_000, safeContext: 200_000, contextConstraint: "moderate", displayName: "Qwen 3 Coder Plus" },
    "qwen3-max": { contextWindow: 262_144, safeContext: 60_000, contextConstraint: "moderate", displayName: "Qwen 3 Max" },
    // ── Fallback — unknown models get maximum caution ──
    "unknown": { contextWindow: 128_000, safeContext: 40_000, contextConstraint: "tight" },
};
// ── Default / fallback models ──
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const FALLBACK_MODEL = "claude-opus-4-7"; // used for planner + worker recovery
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
 * Uses safeContext (not declared contextWindow) so planners scope tasks
 * to what the model can actually handle reliably.
 */
export function contextConstraintNote(model) {
    const cap = getModelCapability(model);
    const safe = Math.round(cap.safeContext / 1000);
    switch (cap.contextConstraint) {
        case "tight":
            return `Worker agents have a TIGHT usable context (~${safe}K tokens). They lose thread and skip steps on large tasks. Be hyper-specific: name exact files, functions, and changes. One narrow deliverable per task. No ambiguity.`;
        case "moderate":
            return `Worker agents have a moderate usable context (~${safe}K tokens). They can handle focused missions but may struggle with sprawling tasks. Be specific about target files and expected outcomes. Scope tasks to clear, concrete deliverables — not open-ended explorations.`;
        case "relaxed":
            return `Worker agents have ~${safe}K usable tokens and high instruction-following. They can own multi-file features with autonomy. Give them missions — "Design and implement X" not "edit line 42 of Y.ts".`;
    }
}
/** Format context window for display (e.g. "256K"). */
export function formatContextWindow(model) {
    const cap = getModelCapability(model);
    if (cap.contextWindow >= 1_000_000)
        return `${(cap.contextWindow / 1_000_000).toFixed(1)}M`;
    return `${Math.round(cap.contextWindow / 1000)}K`;
}
