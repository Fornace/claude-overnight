import type { ModelPick } from "../index.js";
/**
 * Full install + configure flow for cursor-composer-in-claude.
 * Only needed when quick auto-start fails.
 */
export declare function setupCursorProxy(): Promise<boolean>;
export declare function pickCursorModel(): Promise<ModelPick | null>;
