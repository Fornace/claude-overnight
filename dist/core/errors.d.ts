/** HTTP-ish numeric status if present (handles `.status` and `.statusCode`). */
export declare function errStatus(e: unknown): number | undefined;
/** Lower-cased message for substring matching. Falls back to `String(e)`. */
export declare function errMessage(e: unknown): string;
/** `e.cause` if present and distinct from `e` (so callers can recurse safely). */
export declare function errCause(e: unknown): unknown;
