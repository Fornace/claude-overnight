import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { runPlannerQuery, attemptJsonParse, type PlannerLog } from "../query.js";
import { renderWaitingIndicator } from "../../ui/primitives.js";
import { createTurn, beginTurn, endTurn } from "../../core/turns.js";
import { selectKey, ask } from "../../cli/cli.js";
import type { ProviderConfig } from "../../providers/index.js";
import { envFor, isCursorProxyProvider, ensureCursorProxyRunning, PROXY_DEFAULT_URL } from "../../providers/index.js";
import { COACH_SCHEMA, validateCoachOutput, type CoachResult } from "./schema.js";
import { URL_REGEX, fetchUrlContent, collectRepoFacts, renderRepoFacts } from "./context.js";
import { loadUserSettings, saveUserSettings } from "./settings.js";

export { loadUserSettings, saveUserSettings, type UserSettings } from "./settings.js";
export {
  validateCoachOutput,
  type CoachResult,
  type CoachScope,
  type ChecklistLevel,
  type ChecklistRemediation,
  type ChecklistItem,
  type CoachRecommended,
} from "./schema.js";

export const COACH_MODEL = "claude-haiku-4-5";
const COACH_TIMEOUT_MS = 60_000;

export function resolveCoachSkillPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const installRoot = dirname(dirname(dirname(here))); // <pkg>/dist/planner/coach → <pkg>
  const candidates = [
    join(installRoot, "plugins", "claude-overnight", "skills", "coach", "SKILL.md"),
    join(here, "..", "..", "..", "plugins", "claude-overnight", "skills", "coach", "SKILL.md"),
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

export interface CoachContext {
  providers: ProviderConfig[];
  cliFlags: Record<string, string>;
  log?: PlannerLog;
  coachModel?: string;
  coachProvider?: ProviderConfig;
  /** Full markdown plan content (e.g. from a .md plan file). Overrides URL fetching. */
  planContent?: string;
  /** When true, show only accept/skip and do not persist user settings. */
  confirmOnly?: boolean;
}

export async function runSetupCoach(
  rawObjective: string,
  cwd: string,
  ctx: CoachContext,
): Promise<CoachResult | null> {
  const skillPath = resolveCoachSkillPath();
  if (!skillPath) {
    console.log(chalk.dim("  coach skipped: skill unavailable"));
    return null;
  }

  let skill = "";
  try { skill = readFileSync(skillPath, "utf-8"); } catch {
    console.log(chalk.dim("  coach skipped: skill unreadable"));
    return null;
  }

  const facts = collectRepoFacts(cwd);
  if (facts.srcFileCount > 1_000_000) return null;

  let planContent: string | null = ctx.planContent ?? null;
  if (!planContent) {
    const urls = rawObjective.match(URL_REGEX) ?? [];
    if (urls.length > 0) {
      const results = await Promise.all(urls.map(u => fetchUrlContent(u, 4_000)));
      const fetched = results.filter(Boolean) as string[];
      if (fetched.length > 0) {
        planContent = fetched.map((c, i) => `[URL ${i + 1}: ${urls[i]}]\n${c}`).join("\n\n---\n\n");
      }
    }
  }

  const userMessage = renderRepoFacts(facts, rawObjective, ctx.providers, ctx.cliFlags, planContent);
  const prompt = `${skill}\n\n---\n\n${userMessage}\n\nRespond with the JSON object defined in "Invocation contract" only.`;

  // cursor "auto" maps to a slow thinking-class model for large prompts (182s observed).
  // composer-2-fast gives the same quality for structured JSON at ~8s.
  const CURSOR_FAST_MODEL = "composer-2-fast";
  let model = ctx.coachModel ?? COACH_MODEL;
  const startedAt = Date.now();
  const spinner = setInterval(() => {
    const indicator = renderWaitingIndicator("coach", startedAt, { style: "thinking" });
    process.stdout.write(`\x1B[2K\r  ${indicator}`);
  }, 120);

  if (ctx.coachProvider && isCursorProxyProvider(ctx.coachProvider)) {
    const proxyUrl = ctx.coachProvider.baseURL || PROXY_DEFAULT_URL;
    const proxyUp = await ensureCursorProxyRunning(proxyUrl);
    if (!proxyUp) {
      clearInterval(spinner);
      process.stdout.write(`\x1B[2K\r`);
      console.log(chalk.dim("  coach skipped: proxy failed to start"));
      return null;
    }
    if (model === "auto") model = CURSOR_FAST_MODEL;
  }

  let raw: string;
  const turn = createTurn("coach", "Coach", "coach-0", model);
  beginTurn(turn);
  try {
    const queryPromise = runPlannerQuery(prompt, {
      cwd,
      model,
      outputFormat: COACH_SCHEMA,
      transcriptName: "coach",
      maxTurns: 3,
      tools: [],
      env: ctx.coachProvider ? envFor(ctx.coachProvider) : undefined,
      turnId: turn.id,
    }, () => {});
    const timeout = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error(`coach timed out after ${Math.round(COACH_TIMEOUT_MS / 1000)}s`)), COACH_TIMEOUT_MS);
    });
    raw = await Promise.race([queryPromise, timeout]);
    endTurn(turn, "done");
  } catch (err: any) {
    clearInterval(spinner);
    process.stdout.write(`\x1B[2K\r`);
    endTurn(turn, "error");
    const msg = String(err?.message ?? err).toLowerCase();
    const reason = msg.includes("timed out") ? "timeout"
      : (msg.includes("401") || msg.includes("auth")) ? "auth"
      : "network";
    console.log(chalk.dim(`  coach skipped: ${reason}`));
    return null;
  }
  clearInterval(spinner);
  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(`\x1B[2K\r`);

  const parsed = attemptJsonParse(raw);
  const result = validateCoachOutput(parsed);
  if (!result) {
    console.log(chalk.dim("  coach output malformed — skipping"));
    return null;
  }

  renderCoachBlock(result, elapsedMs, model);

  const choice = ctx.confirmOnly
    ? await selectKey("", [
        { key: "y", desc: " accept" },
        { key: "s", desc: "kip" },
      ])
    : await selectKey("", [
        { key: "y", desc: " accept" },
        { key: "e", desc: "dit objective" },
        { key: "s", desc: "kip coach" },
        { key: "x", desc: " skip coach forever" },
      ]);

  if (choice === "y") {
    if (!ctx.confirmOnly) saveUserSettings({ ...loadUserSettings(), lastCoachedAt: Date.now() });
    return result;
  }
  if (choice === "e") {
    const amend = (await ask(`\n  ${chalk.cyan(">")} what would you change? `)).trim();
    if (!amend) return null;
    const amendedPrompt = `${prompt}\n\n---\n\nUser amendment (apply and return a revised JSON object):\n${amend}`;
    const amendTurn = createTurn("coach", "Coach (amended)", "coach-amend-0", model);
    beginTurn(amendTurn);
    try {
      const coachEnv = ctx.coachProvider ? envFor(ctx.coachProvider) : undefined;
      const raw2 = await Promise.race([
        runPlannerQuery(amendedPrompt, {
          cwd, model,
          outputFormat: COACH_SCHEMA, transcriptName: "coach-retry", maxTurns: 3, tools: [],
          env: coachEnv,
          turnId: amendTurn.id,
        }, () => {}),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("coach amendment timed out")), COACH_TIMEOUT_MS)),
      ]);
      endTurn(amendTurn, "done");
      const parsed2 = attemptJsonParse(raw2);
      const result2 = validateCoachOutput(parsed2);
      if (result2) {
        renderCoachBlock(result2, Date.now() - startedAt, model);
        const confirm = await selectKey("", [
          { key: "y", desc: " accept" },
          { key: "s", desc: "kip coach" },
        ]);
        if (confirm === "y") {
          saveUserSettings({ ...loadUserSettings(), lastCoachedAt: Date.now() });
          return result2;
        }
      } else {
        console.log(chalk.dim("  coach amendment malformed — falling through"));
      }
    } catch {
      console.log(chalk.dim("  coach amendment failed — falling through"));
      endTurn(amendTurn, "error");
    }
    return null;
  }
  if (choice === "x") {
    saveUserSettings({ ...loadUserSettings(), skipCoach: true });
    console.log(chalk.dim("  coach disabled — run `claude-overnight --coach` once to re-enable"));
    return null;
  }
  return null;
}

function renderCoachBlock(r: CoachResult, elapsedMs: number, model: string): void {
  const elapsed = (elapsedMs / 1000).toFixed(1);
  console.log(`\n  ${chalk.cyan("⚡")} ${chalk.bold("Coach")} ${chalk.dim(`(${model}, ${elapsed}s)`)}\n`);
  console.log(`  ${chalk.cyan("✦")} ${chalk.bold("Objective")}`);
  for (const line of r.improvedObjective.split("\n")) {
    console.log(`    ${line}`);
  }
  if (r.rationale) console.log(`    ${chalk.dim(r.rationale)}`);

  const rec = r.recommended;
  console.log(`\n  ${chalk.cyan("⚙")} ${chalk.bold("Settings")}`);
  const fastStr = rec.fastModel ? `  fast=${rec.fastModel}` : "";
  console.log(`    planner=${rec.plannerModel}  worker=${rec.workerModel}${fastStr}`);
  const capStr = rec.usageCap != null ? `${Math.round(rec.usageCap * 100)}%` : "unlimited";
  console.log(`    budget=${rec.budget}  concurrency=${rec.concurrency}  flex=${rec.flex ? "on" : "off"}  cap=${capStr}`);
  console.log(`    scope: ${r.scope}`);

  if (r.checklist.length) {
    console.log(`\n  ${chalk.cyan("🔑")} ${chalk.bold("Preflight")}`);
    for (const item of r.checklist) {
      const mark = item.level === "blocking" ? chalk.red("✗")
        : item.level === "warning" ? chalk.yellow("⚠") : chalk.green("✓");
      console.log(`    ${mark} ${item.title}${item.detail ? chalk.dim(` — ${item.detail}`) : ""}`);
    }
  }
  console.log("");
}
