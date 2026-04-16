export interface ModelCapability {
    contextWindow: number;
    safeContext: number;
    contextConstraint: "tight" | "moderate" | "relaxed";
    /** Human-readable label for UI display. Falls back to the model key if absent. */
    displayName?: string;
}
export declare const MODEL_CAPABILITIES: Record<string, ModelCapability>;
export declare const DEFAULT_MODEL = "claude-sonnet-4-6";
export declare const FALLBACK_MODEL = "claude-opus-4-6";
/**
 * Find capability info for a model string. Tries: exact match → lowercase
 * exact → substring match. Falls back to "unknown" entry.
 */
export declare function getModelCapability(model: string): ModelCapability;
/** Human-readable model name for display (e.g. in run labels). */
export declare function modelDisplayName(model: string): string;
/**
 * Context constraint instruction injected into planner prompts.
 * Uses safeContext (not declared contextWindow) so planners scope tasks
 * to what the model can actually handle reliably.
 */
export declare function contextConstraintNote(model: string): string;
/** Format context window for display (e.g. "256K"). */
export declare function formatContextWindow(model: string): string;
