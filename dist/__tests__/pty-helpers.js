import pty from "node-pty";
import * as stripAnsiModule from "strip-ansi";
import { dirname } from "path";
import { fileURLToPath } from "url";
export const __dirname = dirname(fileURLToPath(import.meta.url));
// strip-ansi is ESM-only; require returns { default: fn }
const stripAnsi = typeof stripAnsiModule === "function"
    ? stripAnsiModule
    : stripAnsiModule.default;
/** Lightweight expect-style wrapper around node-pty for E2E terminal testing. */
export class PTYProcess {
    ptyProcess;
    buffer = "";
    dataHandlers = new Set();
    exited = false;
    exitCode;
    constructor(command, args, opts = {}) {
        this.ptyProcess = pty.spawn(command, args, {
            name: "xterm-256color",
            cols: 120,
            rows: 30,
            cwd: process.cwd(),
            env: { ...process.env, ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1" },
            ...opts,
        });
        this.ptyProcess.onData((chunk) => {
            this.buffer += chunk;
            for (const h of this.dataHandlers)
                h(chunk);
        });
        this.ptyProcess.onExit(({ exitCode }) => {
            this.exited = true;
            this.exitCode = exitCode;
        });
    }
    /** Send raw text to stdin (supports ANSI escape sequences for arrow keys, etc.) */
    write(text) {
        this.ptyProcess.write(text);
    }
    /** Send a keystroke by name. Supports: Enter, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight */
    key(name) {
        const map = {
            Enter: "\r",
            Escape: "\x1B",
            ArrowUp: "\x1B[A",
            ArrowDown: "\x1B[B",
            ArrowRight: "\x1B[C",
            ArrowLeft: "\x1B[D",
        };
        this.ptyProcess.write(map[name] ?? name);
    }
    /** Wait until the output buffer contains text matching `pattern`. Returns the raw matched string or throws on timeout. */
    async waitFor(pattern, timeoutMs = 5000) {
        const regex = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
        const existing = this.buffer.match(regex);
        if (existing)
            return existing[0];
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.dataHandlers.delete(onData);
                reject(new Error(`waitFor timeout (${timeoutMs}ms)  -- pattern: ${regex.source}\nLast output:\n${stripAnsi(this.buffer).slice(-2000)}`));
            }, timeoutMs);
            const onData = () => {
                const m = this.buffer.match(regex);
                if (m) {
                    clearTimeout(timer);
                    this.dataHandlers.delete(onData);
                    resolve(m[0]);
                }
            };
            this.dataHandlers.add(onData);
        });
    }
    /** Wait for visible text (ANSI-stripped) to appear in the terminal output. */
    async waitForVisible(text, timeoutMs = 5000) {
        await this.waitFor(text, timeoutMs); // Works since we check raw buffer
    }
    /** Clear the output buffer. */
    clear() {
        this.buffer = "";
    }
    /** Current raw output (with ANSI codes). */
    raw() {
        return this.buffer;
    }
    /** Current output with ANSI codes stripped. */
    text() {
        return stripAnsi(this.buffer);
    }
    /** Kill the process. */
    kill(signal = "SIGTERM") {
        this.ptyProcess.kill(signal);
    }
}
