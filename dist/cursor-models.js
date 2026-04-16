// ── Cursor model constants ──
//
// Hardcoded model IDs returned by the Cursor API Proxy. These serve as a
// fallback when `agent --list-models` crashes (the bundled Node.js binary
// segfaults on some setups — the proxy inherits this bug).
//
// Update this list when Cursor adds/removes models. Run:
//   node ~/.local/share/cursor-agent/versions/*/index.js --list-models
// to get the current list.
//
// The `priority` models always appear at the top of the picker in this order.
// `known` models appear after them. Anything the proxy returns dynamically
// that isn't in this list goes into a "more..." sub-menu.
import { modelDisplayName, formatContextWindow } from "./models.js";
export const CURSOR_PRIORITY_MODELS = [
    { id: "composer-2", label: "composer-2", hint: "Cursor Composer 2 — latest, strongest Cursor model" },
    { id: "auto", label: "auto", hint: "auto-delegates to the best available model" },
];
export const CURSOR_KNOWN_MODELS = [
    { id: "composer", label: "composer", hint: "Cursor Composer — previous generation" },
];
/** All known model IDs as a Set for quick membership checks. */
export const KNOWN_CURSOR_MODEL_IDS = new Set([
    ...CURSOR_PRIORITY_MODELS.map(m => m.id),
    ...CURSOR_KNOWN_MODELS.map(m => m.id),
]);
/** Display hint for a model ID — known ones get a hint, unknowns get a generic label. */
export function cursorModelHint(modelId) {
    const m = modelId.toLowerCase();
    for (const entry of [...CURSOR_PRIORITY_MODELS, ...CURSOR_KNOWN_MODELS]) {
        if (entry.id === m)
            return entry.hint;
    }
    if (m.startsWith("composer"))
        return "Cursor Composer model";
    // For Claude variants through Cursor, use the shared display name
    const displayName = modelDisplayName(modelId);
    if (displayName !== modelId)
        return `${displayName} via Cursor · ${formatContextWindow(modelId)} context`;
    if (m.startsWith("gpt-5"))
        return "GPT model via Cursor";
    if (m.startsWith("gemini"))
        return "Gemini model via Cursor";
    if (m.startsWith("grok"))
        return "Grok model via Cursor";
    return "Cursor model";
}
