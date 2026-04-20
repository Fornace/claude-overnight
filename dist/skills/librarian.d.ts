/** Validate a recipe body has exactly one fenced code block of the declared language. */
export declare function validateRecipeBody(body: string, language: string): {
    valid: boolean;
    reason?: string;
};
export interface LibrarianInput {
    fingerprint: string;
    runId: string;
    wave: number;
    cwd: string;
    model: string;
    envForModel?: (model?: string) => Record<string, string> | undefined;
}
export interface LibrarianResult {
    promoted: number;
    patched: number;
    quarantined: number;
    rejected: number;
    elapsedMs: number;
}
/** End-of-wave librarian pass. Time-boxed; on timeout, logs and returns. */
export declare function runLibrarian(input: LibrarianInput): Promise<LibrarianResult>;
