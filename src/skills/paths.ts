import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REAL_ROOT = join(homedir(), ".claude-overnight", "skills");
let _override: string | undefined;

function root(): string {
  return _override ?? REAL_ROOT;
}

/** Test-only: redirect skillsRoot to a temp dir. */
export function __setRoot(dir: string): void { _override = dir; }
/** Test-only: restore the real root. */
export function __restoreRoot(): void { _override = undefined; }

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function skillsRoot(): string {
  return ensure(root());
}

export function fingerprintDir(fp: string): string {
  return ensure(join(root(), fp));
}

export function candidatesDir(fp: string): string {
  return ensure(join(root(), fp, "candidates"));
}

export function canonDir(fp: string): string {
  return ensure(join(root(), fp, "canon"));
}

export function recipeDir(fp: string): string {
  return ensure(join(root(), fp, "canon", "recipe"));
}

export function quarantineDir(fp: string): string {
  return ensure(join(root(), fp, "quarantine"));
}

export function indexPath(): string {
  return join(root(), "index.sqlite");
}
