import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ROOT = join(homedir(), ".claude-overnight", "skills");

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function skillsRoot(): string {
  return ensure(ROOT);
}

export function fingerprintDir(fp: string): string {
  return ensure(join(ROOT, fp));
}

export function candidatesDir(fp: string): string {
  return ensure(join(ROOT, fp, "candidates"));
}

export function canonDir(fp: string): string {
  return ensure(join(ROOT, fp, "canon"));
}

export function quarantineDir(fp: string): string {
  return ensure(join(ROOT, fp, "quarantine"));
}

export function indexPath(): string {
  return join(ROOT, "index.sqlite");
}
