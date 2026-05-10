/** Read a file as utf-8, returning "" on any error (missing, EACCES, etc).
 *  Replaces `try { readFileSync(p, "utf-8") } catch { return "" }` and the
 *  TOCTOU-prone `existsSync(p) ? readFileSync(p, "utf-8") : ""`. */
export declare function readFileOrEmpty(path: string): string;
/** List `*.md` filenames in a dir, sorted. Missing dir returns `[]`. */
export declare function listMd(dir: string): string[];
/** Read every `*.md` file in a dir (sorted) as `{ name, body }`. Missing dir
 *  returns `[]`. Skips any single file that fails to read. */
export declare function readMdEntries(dir: string): {
    name: string;
    body: string;
}[];
/** Read+parse JSON, returning `null` on any error (missing file, bad JSON).
 *  Eliminates the ubiquitous `try { JSON.parse(readFileSync(...)) } catch { return null }`. */
export declare function readJsonOrNull<T = unknown>(path: string): T | null;
/** Atomically write JSON: mkdir -p the parent, write to a temp sibling, then
 *  rename. Avoids half-written files on crash mid-write. Pretty-printed with
 *  2-space indent + trailing newline (matches existing on-disk format). */
export declare function writeJson(path: string, value: unknown): void;
