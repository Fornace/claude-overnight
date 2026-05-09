// Tiny filesystem helpers that replace ~30 try/catch readFileSync sites and
// a fistful of TOCTOU `existsSync ? readFileSync : ""` patterns scattered
// across state/, run/, prompt-evolution/, planner/coach/ and cli/.
//
// Kept dependency-free (only node:fs + node:path) so any module can import
// without dragging chalk/ink/sdk into a load graph.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** Read a file as utf-8, returning "" on any error (missing, EACCES, etc).
 *  Replaces `try { readFileSync(p, "utf-8") } catch { return "" }` and the
 *  TOCTOU-prone `existsSync(p) ? readFileSync(p, "utf-8") : ""`. */
export function readFileOrEmpty(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

/** Read every `*.md` file in a dir (sorted) as `{ name, body }`. Missing dir
 *  returns `[]`. Skips any single file that fails to read. */
export function readMdEntries(dir: string): { name: string; body: string }[] {
  let names: string[];
  try { names = readdirSync(dir).filter(f => f.endsWith(".md")).sort(); }
  catch { return []; }
  const out: { name: string; body: string }[] = [];
  for (const name of names) {
    const body = readFileOrEmpty(join(dir, name));
    out.push({ name, body });
  }
  return out;
}

/** Read+parse JSON, returning `null` on any error (missing file, bad JSON).
 *  Eliminates the ubiquitous `try { JSON.parse(readFileSync(...)) } catch { return null }`. */
export function readJsonOrNull<T = unknown>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

/** Atomically write JSON: mkdir -p the parent, write to a temp sibling, then
 *  rename. Avoids half-written files on crash mid-write. Pretty-printed with
 *  2-space indent + trailing newline (matches existing on-disk format). */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}
