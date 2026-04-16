import pty from "node-pty";
import * as stripAnsiModule from "strip-ansi";
import { dirname } from "path";
import { fileURLToPath } from "url";

export const __dirname = dirname(fileURLToPath(import.meta.url));

// strip-ansi is ESM-only; require returns { default: fn }
const stripAnsi: (s: string) => string =
  typeof stripAnsiModule === "function"
    ? stripAnsiModule
    : (stripAnsiModule as { default: (s: string) => string }).default;

/** Lightweight expect-style wrapper around node-pty for E2E terminal testing. */
export class PTYProcess {
  private ptyProcess: pty.IPty;
  private buffer = "";
  private dataHandlers: Set<(chunk: string) => void> = new Set();
  public exited = false;
  public exitCode: number | undefined;

  constructor(command: string, args: string[], opts: pty.IPtyForkOptions = {}) {
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
      for (const h of this.dataHandlers) h(chunk);
    });
    this.ptyProcess.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
    });
  }

  /** Send raw text to stdin (supports ANSI escape sequences for arrow keys, etc.) */
  write(text: string): void {
    this.ptyProcess.write(text);
  }

  /** Send a keystroke by name. Supports: Enter, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight */
  key(name: string): void {
    const map: Record<string, string> = {
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
  async waitFor(pattern: RegExp | string, timeoutMs = 5000): Promise<string> {
    const regex = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
    const existing = this.buffer.match(regex);
    if (existing) return existing[0];

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dataHandlers.delete(onData);
        reject(
          new Error(
            `waitFor timeout (${timeoutMs}ms)  -- pattern: ${regex.source}\nLast output:\n${stripAnsi(this.buffer).slice(-2000)}`,
          ),
        );
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
  async waitForVisible(text: string, timeoutMs = 5000): Promise<void> {
    await this.waitFor(text, timeoutMs); // Works since we check raw buffer
  }

  /** Clear the output buffer. */
  clear(): void {
    this.buffer = "";
  }

  /** Current raw output (with ANSI codes). */
  raw(): string {
    return this.buffer;
  }

  /** Current output with ANSI codes stripped. */
  text(): string {
    return stripAnsi(this.buffer);
  }

  /** Kill the process. */
  kill(signal = "SIGTERM"): void {
    this.ptyProcess.kill(signal);
  }
}

/** True if node-pty can spawn (fails in some CI/sandbox environments: `posix_spawnp failed`). */
export function canSpawnPty(): boolean {
  try {
    const proc = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
      name: "xterm-256color",
      cols: 40,
      rows: 10,
      cwd: process.cwd(),
      env: { ...process.env } as { [key: string]: string },
    });
    proc.kill();
    return true;
  } catch {
    return false;
  }
}
