import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
// ── CLI flag parsing ──
export function parseCliFlags(argv) {
    const known = new Set(["concurrency", "model", "timeout", "budget", "usage-cap", "extra-usage-budget", "merge", "perm"]);
    const booleans = new Set(["--dry-run", "-h", "--help", "-v", "--version", "--no-flex", "--allow-extra-usage", "--worktrees", "--no-worktrees", "--yolo"]);
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (booleans.has(arg))
            continue;
        const eq = arg.match(/^--(\w[\w-]*)=(.+)$/);
        if (eq && known.has(eq[1])) {
            flags[eq[1]] = eq[2];
            continue;
        }
        const bare = arg.match(/^--(\w[\w-]*)$/);
        if (bare && known.has(bare[1]) && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
            flags[bare[1]] = argv[++i];
            continue;
        }
        if (!arg.startsWith("--"))
            positional.push(arg);
    }
    return { flags, positional };
}
// ── Auth error detection (re-exported from auth module for backward compatibility) ──
import { isJWTAuthError } from "./auth.js";
/** @deprecated Use isJWTAuthError from auth.ts instead. */
export const isAuthError = isJWTAuthError;
export { isJWTAuthError };
// ── Fetch models via SDK ──
export async function fetchModels(timeoutMs = 10_000) {
    let q;
    let timer;
    try {
        q = query({ prompt: "", options: { persistSession: false } });
        const models = await Promise.race([
            q.supportedModels(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("model_fetch_timeout")), timeoutMs);
            }),
        ]);
        clearTimeout(timer);
        q.close();
        return models;
    }
    catch (err) {
        clearTimeout(timer);
        q?.close();
        if (err.message === "model_fetch_timeout") {
            // Silent: callers fall back to a text prompt with the current value as default.
        }
        else if (isAuthError(err)) {
            console.error(chalk.red("\n  Authentication failed  -- check your API key or run: claude auth\n"));
            process.exit(1);
        }
        else {
            console.warn(chalk.yellow(`\n  Could not fetch models: ${String(err.message || err).slice(0, 80)}  -- continuing with defaults`));
        }
        return [];
    }
}
// ── Bracketed paste + segment-based input ──
//
// When the terminal is in bracketed paste mode, pasted content is wrapped with
// \x1B[200~ ... \x1B[201~ so we can distinguish typed Enter from pasted newlines.
// Multi-line or long pastes are stored as opaque segments and shown as a compact
// [Pasted +N lines] placeholder while editing  -- the full text is substituted on submit.
export const PASTE_START = "\x1B[200~";
export const PASTE_END = "\x1B[201~";
export const PASTE_PLACEHOLDER_MAX = 80;
/** Split a raw stdin chunk into typed and pasted segments. */
export function splitPaste(chunk) {
    const out = [];
    let i = 0;
    while (i < chunk.length) {
        const start = chunk.indexOf(PASTE_START, i);
        if (start === -1) {
            out.push({ type: "typed", text: chunk.slice(i) });
            break;
        }
        if (start > i)
            out.push({ type: "typed", text: chunk.slice(i, start) });
        const bodyStart = start + PASTE_START.length;
        const end = chunk.indexOf(PASTE_END, bodyStart);
        if (end === -1) {
            out.push({ type: "paste", text: chunk.slice(bodyStart) });
            break;
        }
        out.push({ type: "paste", text: chunk.slice(bodyStart, end) });
        i = end + PASTE_END.length;
    }
    return out;
}
export function segmentsToString(segs) {
    return segs.map((s) => s.content).join("");
}
export function renderSegments(segs) {
    return segs.map((s) => {
        if (s.type === "text")
            return s.content;
        const lines = s.content.split("\n").length;
        return chalk.dim(`[Pasted +${lines} line${lines === 1 ? "" : "s"}]`);
    }).join("");
}
export function appendCharToSegments(segs, ch) {
    const last = segs[segs.length - 1];
    if (last && last.type === "text")
        last.content += ch;
    else
        segs.push({ type: "text", content: ch });
}
/** Appends a pasted block. Short single-line pastes inline as text; the rest become placeholders. */
export function appendPasteToSegments(segs, text) {
    if (!text)
        return;
    const norm = text.replace(/\r\n?/g, "\n");
    if (!norm.includes("\n") && norm.length <= PASTE_PLACEHOLDER_MAX) {
        appendCharToSegments(segs, norm);
        return;
    }
    segs.push({ type: "paste", content: norm });
}
/** Backspace removes one char, or an entire paste block atomically. */
export function backspaceSegments(segs) {
    while (segs.length > 0) {
        const last = segs[segs.length - 1];
        if (last.type === "paste") {
            segs.pop();
            return;
        }
        if (last.content.length > 1) {
            last.content = last.content.slice(0, -1);
            return;
        }
        segs.pop();
        return;
    }
}
function stripAnsi(s) {
    return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}
// ── Interactive primitives ──
/**
 * Read a line from the user with bracketed-paste awareness.
 * Pasted multi-line text stays in the buffer as a single block  -- only a typed
 * Enter submits. Falls back to cooked readline when stdin isn't a TTY.
 */
export function ask(question) {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
        const rl = createInterface({ input: stdin, output: stdout });
        return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
    }
    return new Promise((resolve) => {
        const segs = [];
        const tail = question.split("\n").pop() ?? "";
        const tailVisibleLen = stripAnsi(tail).length;
        let prevWrapRows = 0;
        // Only rewrite the input line (and any wrapped continuation rows). The
        // question header above is never touched, so redraws can't stack copies
        // even if the initial write scrolled the viewport.
        const redraw = () => {
            const cols = stdout.columns || 80;
            if (prevWrapRows > 0)
                stdout.write(`\x1B[${prevWrapRows}A`);
            stdout.write("\r\x1B[J");
            const rendered = renderSegments(segs);
            stdout.write(tail + rendered);
            const visible = tailVisibleLen + stripAnsi(rendered).length;
            prevWrapRows = visible > 0 ? Math.floor((visible - 1) / cols) : 0;
        };
        stdout.write(question);
        stdout.write("\x1B[?2004h");
        try {
            stdin.setRawMode(true);
        }
        catch { }
        stdin.resume();
        const cleanup = () => {
            stdout.write("\x1B[?2004l");
            try {
                stdin.setRawMode(false);
            }
            catch { }
            stdin.removeListener("data", onData);
            stdin.pause();
        };
        const onData = (buf) => {
            const chunk = buf.toString();
            for (const seg of splitPaste(chunk)) {
                if (seg.type === "paste") {
                    appendPasteToSegments(segs, seg.text);
                    redraw();
                    continue;
                }
                for (let ci = 0; ci < seg.text.length; ci++) {
                    const ch = seg.text[ci];
                    if (ch === "\r" || ch === "\n") {
                        stdout.write("\n");
                        cleanup();
                        resolve(segmentsToString(segs).trim());
                        return;
                    }
                    if (ch === "\x03") {
                        cleanup();
                        stdout.write("\n");
                        process.exit(130);
                    }
                    if (ch === "\x7F" || ch === "\b") {
                        backspaceSegments(segs);
                        redraw();
                        continue;
                    }
                    // ESC submits the current input (same as Enter)
                    if (ch === "\x1B") {
                        stdout.write("\n");
                        cleanup();
                        resolve(segmentsToString(segs).trim());
                        return;
                    }
                    const code = ch.charCodeAt(0);
                    if (code < 0x20)
                        continue; // control chars
                    if (code >= 0x7F && code < 0xA0)
                        continue; // DEL + C1 controls
                    appendCharToSegments(segs, ch);
                }
                redraw();
            }
        };
        stdin.on("data", onData);
    });
}
export async function select(label, items, defaultIdx = 0) {
    const { stdin, stdout } = process;
    let idx = defaultIdx;
    const draw = (first = false) => {
        if (!first)
            stdout.write(`\x1B[${items.length}A`);
        for (let i = 0; i < items.length; i++) {
            const sel = i === idx;
            const radio = sel ? chalk.cyan("  ● ") : chalk.dim("  ○ ");
            const name = sel ? chalk.white(items[i].name) : chalk.dim(items[i].name);
            const hint = items[i].hint ? chalk.dim(` · ${items[i].hint}`) : "";
            stdout.write(`\x1B[2K${radio}${name}${hint}\n`);
        }
    };
    stdout.write(`\n  ${chalk.bold(label)}\n`);
    draw(true);
    return new Promise((resolve) => {
        stdin.setRawMode(true);
        stdin.resume();
        const done = (val) => {
            stdin.setRawMode(false);
            stdin.removeListener("data", handler);
            stdin.pause();
            resolve(val);
        };
        const handler = (buf) => {
            const s = buf.toString();
            // Arrow keys: \x1B[A = up, \x1B[B = down
            if (s === "\x1B[A") {
                idx = (idx - 1 + items.length) % items.length;
                draw();
                return;
            }
            if (s === "\x1B[B") {
                idx = (idx + 1) % items.length;
                draw();
                return;
            }
            // Ignore any other ANSI escape sequences
            if (s[0] === "\x1B")
                return;
            if (s === "\r")
                done(items[idx].value);
            else if (s === "\x03") {
                stdin.setRawMode(false);
                process.exit(0);
            }
            else if (/^[1-9]$/.test(s)) {
                const n = parseInt(s) - 1;
                if (n < items.length) {
                    idx = n;
                    draw();
                    done(items[idx].value);
                }
            }
        };
        stdin.on("data", handler);
    });
}
export async function selectKey(label, options) {
    const { stdin, stdout } = process;
    const keys = options.map((o) => o.key.toLowerCase());
    const optStr = options.map((o) => `${chalk.cyan.bold(o.key.toUpperCase())}${chalk.dim(o.desc)}`).join(chalk.dim("  │  "));
    stdout.write(`\n  ${label}\n  ${optStr}\n  `);
    return new Promise((resolve) => {
        stdin.setRawMode(true);
        stdin.resume();
        const handler = (buf) => {
            const s = buf.toString().toLowerCase();
            // Ignore ANSI escape sequences
            if (s[0] === "\x1B")
                return;
            if (s === "\x03") {
                stdin.setRawMode(false);
                process.exit(0);
            }
            if (s === "\r") {
                stdin.setRawMode(false);
                stdin.removeListener("data", handler);
                stdin.pause();
                resolve(keys[0]);
                return;
            }
            if (s.length === 1 && keys.includes(s)) {
                stdin.setRawMode(false);
                stdin.removeListener("data", handler);
                stdin.pause();
                resolve(s);
            }
        };
        stdin.on("data", handler);
    });
}
const KNOWN_TASK_FILE_KEYS = new Set([
    "tasks", "objective", "concurrency", "cwd", "model", "permissionMode", "allowedTools", "worktrees", "mergeStrategy", "usageCap", "flexiblePlan",
]);
export function loadTaskFile(file) {
    const path = resolve(file);
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch {
        throw new Error(`Cannot read task file: ${path}`);
    }
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch {
        throw new Error(`Task file is not valid JSON: ${path}`);
    }
    const parsed = Array.isArray(json) ? { tasks: json } : json;
    if (!Array.isArray(json) && typeof json === "object" && json !== null) {
        const unknown = Object.keys(json).filter((k) => !KNOWN_TASK_FILE_KEYS.has(k));
        if (unknown.length > 0) {
            throw new Error(`Unknown key${unknown.length > 1 ? "s" : ""} in task file: ${unknown.join(", ")}. Allowed: ${[...KNOWN_TASK_FILE_KEYS].join(", ")}`);
        }
    }
    if (!Array.isArray(parsed.tasks))
        throw new Error(`Task file must contain a "tasks" array (got ${typeof parsed.tasks})`);
    const tasks = [];
    for (let i = 0; i < parsed.tasks.length; i++) {
        const t = parsed.tasks[i];
        const id = String(tasks.length);
        if (typeof t === "string") {
            if (!t.trim())
                throw new Error(`Task ${i} is an empty string`);
            tasks.push({ id, prompt: t });
        }
        else if (typeof t === "object" && t !== null) {
            if (typeof t.prompt !== "string" || !t.prompt.trim())
                throw new Error(`Task ${i} is missing a "prompt" string`);
            tasks.push({ id, prompt: t.prompt, cwd: t.cwd ? resolve(t.cwd) : undefined, model: t.model });
        }
        else {
            throw new Error(`Task ${i} must be a string or object with a "prompt" field (got ${typeof t})`);
        }
    }
    if (parsed.concurrency !== undefined)
        validateConcurrency(parsed.concurrency);
    const usageCap = parsed.usageCap;
    if (usageCap != null && (typeof usageCap !== "number" || usageCap < 0 || usageCap > 100)) {
        throw new Error(`usageCap must be a number between 0 and 100 (got ${JSON.stringify(usageCap)})`);
    }
    if (parsed.flexiblePlan && typeof parsed.objective !== "string") {
        throw new Error(`flexiblePlan requires an "objective" string in the task file`);
    }
    return {
        tasks,
        objective: typeof parsed.objective === "string" ? parsed.objective : undefined,
        concurrency: parsed.concurrency,
        model: parsed.model,
        cwd: parsed.cwd ? resolve(parsed.cwd) : undefined,
        permissionMode: parsed.permissionMode,
        allowedTools: parsed.allowedTools,
        useWorktrees: parsed.worktrees,
        mergeStrategy: parsed.mergeStrategy,
        usageCap,
        flexiblePlan: parsed.flexiblePlan,
    };
}
// ── Validation helpers ──
export function validateConcurrency(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`Concurrency must be a positive integer (got ${JSON.stringify(value)})`);
    }
}
export function isGitRepo(cwd) {
    try {
        execSync("git rev-parse --git-dir", { cwd, encoding: "utf-8", stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
}
export function validateGitRepo(cwd) {
    if (!isGitRepo(cwd)) {
        throw new Error(`Worktrees require a git repository, but ${cwd} is not inside one.\n` +
            `  Run: cd ${cwd} && git init\n` +
            `  Or set "worktrees": false in your task file.`);
    }
}
// ── Display helpers ──
export function showPlan(tasks) {
    const w = Math.max((process.stdout.columns ?? 80) - 6, 40);
    const ruleLen = Math.min(w, 70);
    console.log(chalk.dim(`  ─── ${tasks.length} tasks ${"─".repeat(Math.max(0, ruleLen - String(tasks.length).length - 10))}`));
    for (const t of tasks) {
        const num = chalk.dim(String(Number(t.id) + 1).padStart(4) + ".");
        console.log(`${num} ${t.prompt.slice(0, w)}`);
    }
    console.log(chalk.dim(`  ${"─".repeat(ruleLen)}\n`));
}
export const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function makeProgressLog() {
    let frame = 0;
    return (text) => {
        const spin = chalk.cyan(BRAILLE[frame++ % BRAILLE.length]);
        const maxW = (process.stdout.columns ?? 80) - 6;
        const clean = text.replace(/\n/g, " ");
        const line = clean.length > maxW ? clean.slice(0, maxW - 1) + "\u2026" : clean;
        process.stdout.write(`\x1B[2K\r  ${spin} ${chalk.dim(line)}`);
    };
}
