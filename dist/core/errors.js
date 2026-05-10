// Tiny error-shape extractors. Replace `(err as any).status / .message / .cause`
// casts so callers narrow on the structural shape instead of leaking `any`.
//
// Lives in core/ (not swarm/) because both the swarm worker loop and any
// future fetch-style call site (planner, prompt-evolution, providers) need
// the same extraction. swarm/errors.ts re-exports these to keep its existing
// import paths stable.
const asErrorLike = (e) => (e ?? {});
/** HTTP-ish numeric status if present (handles `.status` and `.statusCode`). */
export function errStatus(e) {
    const v = asErrorLike(e).status ?? asErrorLike(e).statusCode;
    return typeof v === "number" ? v : undefined;
}
/** Lower-cased message for substring matching. Falls back to `String(e)`. */
export function errMessage(e) {
    const m = asErrorLike(e).message;
    return String(typeof m === "string" ? m : e).toLowerCase();
}
/** `e.cause` if present and distinct from `e` (so callers can recurse safely). */
export function errCause(e) {
    const c = asErrorLike(e).cause;
    return c && c !== e ? c : undefined;
}
