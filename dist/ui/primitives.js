// Pure formatting primitives shared by the Ink tree and the post-run summary.
//
// Nothing here knows about Swarm, rate limits, or steering state — just
// strings, durations, and spinner ticks. Keeping these dependency-free means
// the live components and the string-based summary can compose them freely.
import chalk from "chalk";
const SPINNER = ["|", "/", "-", "\\"];
const DOTS = ["\u2846", "\u2807", "\u280B", "\u2819", "\u2838", "\u28B0", "\u28E0", "\u28C4"];
/** Single-frame character of a spinner. */
export function spinnerFrame(kind = "dots") {
    const arr = kind === "line" ? SPINNER : DOTS;
    return arr[Math.floor(Date.now() / 120) % arr.length];
}
/** Reusable indicator for any in-flight wait. Always shows animation + elapsed
 *  time so no phase ever appears frozen. `eta` (future timestamp) adds a
 *  countdown; `hint` appends a short secondary label.
 *
 *  Returns a chalk-styled string — use inside plain stdout prints or inside an
 *  Ink `<Text>` (ANSI escapes pass through unchanged). */
export function renderWaitingIndicator(label, startedAt, opts = {}) {
    const color = opts.style === "warn" ? chalk.yellow
        : opts.style === "wait" ? chalk.magenta
            : opts.style === "thinking" ? chalk.cyan
                : chalk.blue;
    const spin = color(spinnerFrame("dots"));
    let out = `${spin} ${label}`;
    if (startedAt)
        out += `  ${chalk.dim(fmtDur(Math.max(0, Date.now() - startedAt)))}`;
    if (opts.eta && opts.eta > Date.now()) {
        out += chalk.dim(`${startedAt ? " \u00b7 " : "  "}${fmtDur(opts.eta - Date.now())} left`);
    }
    if (opts.hint)
        out += chalk.dim(` \u00b7 ${opts.hint}`);
    return out;
}
/** Current terminal width clamped to a 60-char floor — what every panel uses
 *  to decide bar/column sizes. Stays here so the heuristic lives in one spot. */
export function terminalWidth() {
    return Math.max((process.stdout.columns ?? 80) || 80, 60);
}
export function truncate(s, max) {
    return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}
/** Visible length of a string — ANSI escapes stripped. Use when aligning
 *  columns of chalk-colored text. */
export function visibleLen(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
/** `padEnd` that counts visible characters, so ANSI-colored strings align. */
export function padVisible(s, width) {
    const vl = visibleLen(s);
    return vl >= width ? s : s + " ".repeat(width - vl);
}
/** Word-wrap text into lines of at most `max` chars. Splits on spaces; hard-breaks
 *  single words longer than `max`. Ignores ANSI escape codes for length. */
export function wrap(s, max) {
    if (s.length <= max)
        return [s];
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
    if (stripped.length <= max)
        return [s];
    const lines = [];
    const words = stripped.split(/\s+/);
    let cur = "";
    for (const w of words) {
        if (cur.length === 0) {
            cur = w;
            continue;
        }
        if (cur.length + 1 + w.length <= max) {
            cur += " " + w;
        }
        else {
            lines.push(cur);
            cur = w;
        }
    }
    if (cur)
        lines.push(cur);
    return lines;
}
export function fmtTokens(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
export function fmtDur(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
/** Color a free-form event string by heuristic. */
export function colorEvent(text) {
    if (text === "Done" || text.startsWith("Merged ") || text.startsWith("Committed "))
        return chalk.green(text);
    if (text.startsWith("Rate:") || text.startsWith("Rate limited") || text.startsWith("Soft throttle"))
        return chalk.magenta(text);
    if (/error|fail|conflict/i.test(text))
        return chalk.red(text);
    if (!text.includes(" ") && text.length <= 40)
        return chalk.yellow(text);
    return text;
}
/** Context-fill percentage and chalk color for a token count vs safe limit.
 *  Green under 50%, yellow past 50%, red past 80%. */
export function contextFillInfo(tokens, safe) {
    const pct = safe > 0 ? Math.round((tokens / safe) * 100) : 0;
    const color = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
    return { pct, color };
}
