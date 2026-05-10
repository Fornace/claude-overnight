// Tiny error-shape extractors. Replace `(err as any).status / .message / .cause`
// casts so callers narrow on the structural shape instead of leaking `any`.
//
// Lives in core/ (not swarm/) because both the swarm worker loop and any
// future fetch-style call site (planner, prompt-evolution, providers) need
// the same extraction. swarm/errors.ts re-exports these to keep its existing
// import paths stable.

type ErrorLike = { message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };

const asErrorLike = (e: unknown): ErrorLike => (e ?? {}) as ErrorLike;

/** HTTP-ish numeric status if present (handles `.status` and `.statusCode`). */
export function errStatus(e: unknown): number | undefined {
  const v = asErrorLike(e).status ?? asErrorLike(e).statusCode;
  return typeof v === "number" ? v : undefined;
}

/** Lower-cased message for substring matching. Falls back to `String(e)`. */
export function errMessage(e: unknown): string {
  const m = asErrorLike(e).message;
  return String(typeof m === "string" ? m : e).toLowerCase();
}

/** `e.cause` if present and distinct from `e` (so callers can recurse safely). */
export function errCause(e: unknown): unknown {
  const c = asErrorLike(e).cause;
  return c && c !== e ? c : undefined;
}
