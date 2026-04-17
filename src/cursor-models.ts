// ── Cursor model constants ──
//
// Hardcoded model IDs returned by the Cursor API Proxy. These serve as a
// fallback when `agent --list-models` crashes (the bundled Node.js binary
// segfaults on some setups — the proxy inherits this bug).
//
// Update this list when Cursor adds/removes models. Run:
//   agent --list-models
// to get the current list.
//
// The `priority` models always appear at the top of the picker in this order.
// `known` models appear after them. Anything the proxy returns dynamically
// that isn't in this list goes into a "more..." sub-menu.

import { modelDisplayName, formatContextWindow } from "./models.js";

export const CURSOR_PRIORITY_MODELS: Array<{ id: string; label: string; hint: string }> = [
  { id: "claude-opus-4-7", label: "claude-opus-4-7", hint: "Claude Opus 4.7 — latest Anthropic flagship, best agentic coder" },
  { id: "gpt-5.4", label: "gpt-5.4", hint: "GPT-5.4 — latest OpenAI flagship, 1M context" },
  { id: "gemini-3.1-pro", label: "gemini-3.1-pro", hint: "Gemini 3.1 Pro — latest Google flagship" },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "Claude Sonnet 4.6 — best speed/intelligence balance" },
  { id: "composer-2", label: "composer-2", hint: "Cursor Composer 2 — latest Cursor-native model" },
  { id: "auto", label: "auto", hint: "auto-delegates to the best available model" },
];

export const CURSOR_KNOWN_MODELS: Array<{ id: string; label: string; hint: string }> = [
  { id: "composer-2-fast", label: "composer-2-fast", hint: "Cursor Composer 2 Fast — faster, cheaper variant" },
  { id: "composer-1.5", label: "composer-1.5", hint: "Cursor Composer 1.5 — previous generation" },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex", hint: "Codex 5.3 — OpenAI's best agentic coder" },
  { id: "grok-4-20", label: "grok-4-20", hint: "Grok 4.20 — xAI model" },
  { id: "kimi-k2.5", label: "kimi-k2.5", hint: "Kimi K2.5 — Moonshot model" },
];

/** All known model IDs as a Set for quick membership checks. */
export const KNOWN_CURSOR_MODEL_IDS = new Set([
  ...CURSOR_PRIORITY_MODELS.map(m => m.id),
  ...CURSOR_KNOWN_MODELS.map(m => m.id),
]);

/** Display hint for a model ID — known ones get a hint, unknowns get a generic label. */
export function cursorModelHint(modelId: string): string {
  const m = modelId.toLowerCase();
  for (const entry of [...CURSOR_PRIORITY_MODELS, ...CURSOR_KNOWN_MODELS]) {
    if (entry.id === m) return entry.hint;
  }
  if (m.startsWith("composer")) return "Cursor Composer model";
  // For Claude variants through Cursor, use the shared display name
  const displayName = modelDisplayName(modelId);
  if (displayName !== modelId) return `${displayName} via Cursor · ${formatContextWindow(modelId)} context`;
  if (m.startsWith("gpt-5")) return "GPT model via Cursor";
  if (m.startsWith("gemini")) return "Gemini model via Cursor";
  if (m.startsWith("grok")) return "Grok model via Cursor";
  if (m.startsWith("kimi")) return "Kimi model via Cursor";
  if (m.startsWith("claude")) return "Claude model via Cursor";
  return "Cursor model";
}
