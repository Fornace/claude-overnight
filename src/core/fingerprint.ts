import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { execSync } from "node:child_process";

/** SHA-256 of git remote URL (or realpath fallback), first 12 chars. */
export function computeRepoFingerprint(cwd: string): string {
  try {
    const remote = execSync("git -C " + JSON.stringify(cwd) + " config --get remote.origin.url", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (remote) return createHash("sha256").update(remote).digest("hex").slice(0, 12);
  } catch {}
  try {
    return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12);
  } catch {
    return "000000000000";
  }
}
