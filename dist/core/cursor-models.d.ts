export declare const CURSOR_PRIORITY_MODELS: Array<{
    id: string;
    label: string;
    hint: string;
}>;
export declare const CURSOR_KNOWN_MODELS: Array<{
    id: string;
    label: string;
    hint: string;
}>;
/** All known model IDs as a Set for quick membership checks. */
export declare const KNOWN_CURSOR_MODEL_IDS: Set<string>;
/** Display hint for a model ID — known ones get a hint, unknowns get a generic label. */
export declare function cursorModelHint(modelId: string): string;
