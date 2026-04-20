import { writeFileSync, renameSync, readdirSync } from "fs";
import { join } from "path";
import { candidatesDir } from "./paths.js";

const BODY_MAX = 5 * 1024; // 5KB
const QUEUE_CAP = 50;

export interface CandidateInput {
  kind: "skill" | "tool-recipe" | "heuristic";
  proposedBy: string;
  wave: number;
  runId: string;
  fingerprint: string;
  trigger: string;
  body: string;
}

export function writeCandidate(input: CandidateInput): { wrote: boolean; dropped: boolean } {
  try {
    const dir = candidatesDir(input.fingerprint);
    const count = readdirSync(dir).filter(f => f.endsWith(".md")).length;
    if (count >= QUEUE_CAP) {
      debug(`scribe: back-pressure at ${count} candidates, dropping`);
      return { wrote: false, dropped: true };
    }

    let body = input.body;
    let truncationNote = "";
    if (Buffer.byteLength(body, "utf-8") > BODY_MAX) {
      const maxChars = Math.floor(BODY_MAX * 0.9); // safe margin for multibyte
      body = body.slice(0, maxChars);
      truncationNote = "\n\n> [truncated at 5KB by scribe]";
    }

    const frontmatter = [
      "---",
      `kind: "${input.kind}"`,
      `proposed_by: "${escapeYaml(input.proposedBy)}"`,
      `wave: ${input.wave}`,
      `run_id: "${escapeYaml(input.runId)}"`,
      `trigger: "${escapeYaml(input.trigger.slice(0, 120))}"`,
      `status: "new"`,
      `created_at: "${new Date().toISOString()}"`,
      "---",
      "",
    ].join("\n");

    const content = `${frontmatter}# ${input.trigger}\n\n${body}${truncationNote}\n`;
    const ts = new Date().toISOString().replace(/:/g, "-");
    const safeName = input.proposedBy.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const filename = `${ts}-${safeName}.md`;
    const target = join(dir, filename);
    const tmp = target + ".tmp";

    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, target);
    return { wrote: true, dropped: false };
  } catch (err) {
    debug(`scribe: writeCandidate failed: ${String(err)}`);
    return { wrote: false, dropped: false };
  }
}

export { computeRepoFingerprint } from "../core/fingerprint.js";

function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function debug(msg: string): void {
  // Hook into the project's debug sink; for now stderr.
  process.stderr.write(`[scribe] ${msg}\n`);
}
