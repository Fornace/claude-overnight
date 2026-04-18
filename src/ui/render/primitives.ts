// Pure formatting primitives used across every rendered frame.
//
// Nothing here knows about Swarm, rate limits, or steering state — just
// strings, durations, and spinner ticks. Keeping these dependency-free means
// the heavier renderers (bars, steering, the unified frame) can compose them
// freely without dragging each other into import cycles.

import chalk from "chalk";

// ── Spinner frames ──
//
// Two flavors so callers pick the feel they want without importing the arrays
// directly. `DOTS` is the default — higher frame count means long waits never
// look frozen.
const SPINNER = ["|", "/", "-", "\\"] as const;
const DOTS = ["\u2846", "\u2807", "\u280B", "\u2819", "\u2838", "\u28B0", "\u28E0", "\u28C4"] as const;

/** Single-frame character of a spinner. Exported so any caller can prefix its
 *  own line with a consistent animation without importing the frame arrays. */
export function spinnerFrame(kind: "line" | "dots" = "dots"): string {
  const arr = kind === "line" ? SPINNER : DOTS;
  return arr[Math.floor(Date.now() / 120) % arr.length];
}

/** Reusable indicator for any in-flight wait. Always shows animation + elapsed
 *  time so no phase ever appears frozen. `eta` (future timestamp) adds a
 *  countdown; `hint` appends a short secondary label.
 *
 *  style:
 *    - "thinking" (cyan): planner/AI reasoning
 *    - "wait"     (magenta): rate-limit / cooldown
 *    - "warn"     (yellow): degraded / blocked
 *    - "info"     (blue): default */
export function renderWaitingIndicator(
  label: string,
  startedAt: number | undefined,
  opts: { eta?: number; hint?: string; style?: "info" | "warn" | "wait" | "thinking" } = {},
): string {
  const color = opts.style === "warn" ? chalk.yellow
    : opts.style === "wait" ? chalk.magenta
    : opts.style === "thinking" ? chalk.cyan
    : chalk.blue;
  const spin = color(spinnerFrame("dots"));
  let out = `${spin} ${label}`;
  if (startedAt) out += `  ${chalk.dim(fmtDur(Math.max(0, Date.now() - startedAt)))}`;
  if (opts.eta && opts.eta > Date.now()) {
    out += chalk.dim(`${startedAt ? " \u00b7 " : "  "}${fmtDur(opts.eta - Date.now())} left`);
  }
  if (opts.hint) out += chalk.dim(` \u00b7 ${opts.hint}`);
  return out;
}

// ── String helpers ──

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

/** Word-wrap text into lines of at most `max` chars.
 *  Splits on spaces; if a single word exceeds `max` it is hard-broken.
 *  Ignores ANSI escape codes for length calculation. */
export function wrap(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= max) return [s];
  const lines: string[] = [];
  const words = stripped.split(/\s+/);
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) { cur = w; continue; }
    if (cur.length + 1 + w.length <= max) { cur += " " + w; }
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── Number formatters ──

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Event & divider styling ──

/** Color a free-form event string by heuristic: green for successes,
 *  magenta for rate-limits, red for failures, yellow for short status tags. */
export function colorEvent(text: string): string {
  if (text === "Done" || text.startsWith("Merged ") || text.startsWith("Committed ")) return chalk.green(text);
  if (text.startsWith("Rate:") || text.startsWith("Rate limited") || text.startsWith("Soft throttle")) return chalk.magenta(text);
  if (/error|fail|conflict/i.test(text)) return chalk.red(text);
  if (!text.includes(" ") && text.length <= 40) return chalk.yellow(text);
  return text;
}

/** Push a grey section divider of the form `--- title ----` into `out`. */
export function section(out: string[], w: number, title: string): void {
  const inner = ` ${title} `;
  const dashW = Math.max(3, Math.min(w - 6, 96) - inner.length);
  out.push(chalk.gray("  \u2500\u2500\u2500" + inner + "\u2500".repeat(dashW)));
}
