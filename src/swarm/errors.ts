// Error classification + sleep helper for the swarm worker loop.
// Kept free-standing so both swarm.ts and the agent-run split can import them
// without tangling the class surface.

export class AgentTimeoutError extends Error {
  constructor(silentMs: number) {
    super(`Agent silent for ${Math.round(silentMs / 1000)}s  -- assumed hung`);
    this.name = "AgentTimeoutError";
  }
}

/** Thrown when the SDK query stream stops emitting assistant content for too long while still open. */
export class StreamStalledError extends Error {
  constructor(
    public readonly elapsed: number,
    public readonly timeoutMs: number,
  ) {
    super(`Stream stalled: no content for ${timeoutMs}ms (last gap ${Math.round(elapsed)}ms)`);
    this.name = "StreamStalledError";
  }
}

export function isStreamStalledError(err: unknown): err is StreamStalledError {
  return err instanceof StreamStalledError;
}

export function isRateLimitError(err: unknown): boolean {
  const status: number | undefined = (err as any)?.status ?? (err as any)?.statusCode;
  if (status === 429) return true;
  const msg = String((err as any)?.message || err).toLowerCase();
  if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("too many requests")) return true;
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isRateLimitError(cause);
  return false;
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof AgentTimeoutError || err instanceof StreamStalledError) return false;
  const msg = String((err as any)?.message || err).toLowerCase();
  const status: number | undefined = (err as any)?.status ?? (err as any)?.statusCode;
  if (status === 429 || (status != null && status >= 500 && status < 600) ||
    msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("econnreset") ||
    msg.includes("etimedout") || msg.includes("socket hang up") || msg.includes("epipe") ||
    msg.includes("econnrefused") || msg.includes("ehostunreach") || msg.includes("network error") ||
    msg.includes("fetch failed") || msg.includes("aborted")) return true;
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isTransientError(cause);
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
