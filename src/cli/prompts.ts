// Interactive terminal primitives: ask, select, selectKey.
//
// Text entry goes through the shared raw-input parser in `../ui/raw-input.ts`,
// which enforces the single invariant that used to be duplicated (and buggy)
// here and in the Ink overlay:
//   - Typed Enter = a stdin chunk that is exactly "\r", "\n", or "\r\n".
//   - Anything else with embedded newlines is a paste, not a submit.
// Multi-line pastes render as a compact `[Pasted +N lines]` placeholder while
// editing — the full content is substituted on submit.

import { createInterface } from "readline";
import chalk from "chalk";
import { parseChunk, setBracketedPaste, deleteWordBackward } from "../ui/raw-input.js";

export const PASTE_PLACEHOLDER_MAX = 80;

type InputSegment = { type: "text"; content: string } | { type: "paste"; content: string };

function appendTypedChar(segs: InputSegment[], ch: string): void {
  const last = segs[segs.length - 1];
  if (last && last.type === "text") last.content += ch;
  else segs.push({ type: "text", content: ch });
}

function appendPaste(segs: InputSegment[], text: string): void {
  if (!text) return;
  const norm = text.replace(/\r\n?/g, "\n");
  if (!norm.includes("\n") && norm.length <= PASTE_PLACEHOLDER_MAX) {
    appendTypedChar(segs, norm);
    return;
  }
  segs.push({ type: "paste", content: norm });
}

function backspaceSegs(segs: InputSegment[]): void {
  while (segs.length > 0) {
    const last = segs[segs.length - 1];
    if (last.type === "paste") { segs.pop(); return; }
    if (last.content.length > 1) { last.content = last.content.slice(0, -1); return; }
    segs.pop();
    return;
  }
}

const segsToString = (segs: InputSegment[]): string => segs.map((s) => s.content).join("");

function renderSegs(segs: InputSegment[]): string {
  return segs.map((s) => {
    if (s.type === "text") return s.content;
    const lines = s.content.split("\n").length;
    return chalk.dim(`[Pasted +${lines} line${lines === 1 ? "" : "s"}]`);
  }).join("");
}

const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

/**
 * Read a line from the user with bracketed-paste awareness. Pasted multi-line
 * text stays in the buffer as a single block — only a typed Enter submits.
 * Falls back to cooked readline when stdin isn't a TTY.
 */
export function ask(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
  }

  return new Promise((resolve) => {
    const segs: InputSegment[] = [];
    const tail = question.split("\n").pop() ?? "";
    const tailVisibleLen = stripAnsi(tail).length;
    let prevWrapRows = 0;

    const redraw = () => {
      const cols = stdout.columns || 80;
      if (prevWrapRows > 0) stdout.write(`\x1B[${prevWrapRows}A`);
      stdout.write("\r\x1B[J");
      const rendered = renderSegs(segs);
      stdout.write(tail + rendered);
      const visible = tailVisibleLen + stripAnsi(rendered).length;
      prevWrapRows = visible > 0 ? Math.floor((visible - 1) / cols) : 0;
    };

    stdout.write(question);
    setBracketedPaste(stdout, true);
    try { stdin.setRawMode!(true); } catch {}
    stdin.resume();

    const cleanup = () => {
      setBracketedPaste(stdout, false);
      try { stdin.setRawMode!(false); } catch {}
      stdin.removeListener("data", onData);
      stdin.pause();
    };
    const submit = () => { stdout.write("\n"); cleanup(); resolve(segsToString(segs).trim()); };

    const onData = (buf: Buffer) => {
      for (const ev of parseChunk(buf.toString())) {
        switch (ev.type) {
          case "char": appendTypedChar(segs, ev.text); break;
          case "paste": appendPaste(segs, ev.text); break;
          case "backspace": backspaceSegs(segs); break;
          case "word-delete": {
            const next = deleteWordBackward(segsToString(segs));
            segs.length = 0;
            if (next) segs.push({ type: "text", content: next });
            break;
          }
          case "clear-line": segs.length = 0; break;
          case "submit": submit(); return;
          case "cancel": submit(); return; // lone ESC = submit, preserves old behavior
          case "interrupt": cleanup(); stdout.write("\n"); process.exit(130);
          // tab + nav: ignore during single-line prompts
        }
      }
      redraw();
    };

    stdin.on("data", onData);
  });
}

export async function select<T>(label: string, items: { name: string; value: T; hint?: string }[], defaultIdx = 0): Promise<T> {
  const { stdin, stdout } = process;
  let idx = defaultIdx;

  const draw = (first = false) => {
    if (!first) stdout.write(`\x1B[${items.length}A`);
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
    stdin.setRawMode!(true);
    stdin.resume();
    const done = (val: T) => {
      stdin.setRawMode!(false);
      stdin.removeListener("data", handler);
      stdin.pause();
      resolve(val);
    };
    const handler = (buf: Buffer) => {
      const s = buf.toString();
      // Arrow keys: \x1B[A = up, \x1B[B = down. Ignore other escape sequences.
      if (s === "\x1B[A") { idx = (idx - 1 + items.length) % items.length; draw(); return; }
      if (s === "\x1B[B") { idx = (idx + 1) % items.length; draw(); return; }
      if (s[0] === "\x1B") return;
      if (s === "\r") done(items[idx].value);
      else if (s === "\x03") { stdin.setRawMode!(false); process.exit(0); }
      else if (/^[1-9]$/.test(s)) {
        const n = parseInt(s) - 1;
        if (n < items.length) { idx = n; draw(); done(items[idx].value); }
      }
    };
    stdin.on("data", handler);
  });
}

export async function selectKey(label: string, options: { key: string; desc: string }[]): Promise<string> {
  const { stdin, stdout } = process;
  const keys = options.map((o) => o.key.toLowerCase());
  const optStr = options.map((o) => `${chalk.cyan.bold(o.key.toUpperCase())}${chalk.dim(o.desc)}`).join(chalk.dim("  │  "));
  stdout.write(`\n  ${label}\n  ${optStr}\n  `);

  return new Promise((resolve) => {
    stdin.setRawMode!(true);
    stdin.resume();
    const finish = (val: string) => {
      stdin.setRawMode!(false);
      stdin.removeListener("data", handler);
      stdin.pause();
      resolve(val);
    };
    const handler = (buf: Buffer) => {
      const s = buf.toString().toLowerCase();
      if (s[0] === "\x1B") return;
      if (s === "\x03") { stdin.setRawMode!(false); process.exit(0); }
      if (s === "\r") return finish(keys[0]);
      if (s.length === 1 && keys.includes(s)) finish(s);
    };
    stdin.on("data", handler);
  });
}
