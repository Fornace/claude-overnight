import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

/**
 * Crash-safe NDJSON transcripts for planner/steering queries.
 *
 * Each query writes to `<runDir>/transcripts/<name>.ndjson`  -- one JSON object
 * per line, so partial writes survive crashes. Multiple invocations of the same
 * name append with a `session_start` marker separating them.
 *
 * Why NDJSON:
 *   - append-only → no read-modify-write race under parallel waves
 *   - one line per event → `tail -f` works; a killed process never leaves
 *     the file in an unparseable state
 *   - machine-readable → this assistant and future tools can `jq` through it
 *
 * Consumed by: planner-query.ts (stream_event, rate_limit_event, result, error).
 */

let _runDir: string | undefined;

export function setTranscriptRunDir(dir: string | undefined): void {
  _runDir = dir;
}

export function getTranscriptRunDir(): string | undefined {
  return _runDir;
}

export function transcriptPath(name: string): string | undefined {
  return _runDir ? join(_runDir, "transcripts", `${name}.ndjson`) : undefined;
}

/** Names that already errored — guard against repeated stderr spam. */
const _seenErrors = new Set<string>();

/** Append a single event; log to stderr once per name on failure (C5). */
export function writeTranscriptEvent(name: string, event: Record<string, unknown>): void {
  const path = transcriptPath(name);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ t: Date.now(), ...event }) + "\n", "utf-8");
  } catch (err: unknown) {
    if (!_seenErrors.has(name)) {
      _seenErrors.add(name);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[transcript] writeTranscriptEvent("${name}") failed: ${msg}\n`);
    }
  }
}
