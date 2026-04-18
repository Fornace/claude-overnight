// The steering-phase frame. Between waves the planner runs solo — no swarm —
// so this frame has a very different shape from the run-phase one: an
// objective line, an optional status block, a last-wave recap, and a live
// ticker of planner activity.

import chalk from "chalk";
import type { RLGetter, WaveSummary } from "../../core/types.js";
import type { RunInfo, SteeringContext, SteeringEvent } from "../ui.js";
import { modelDisplayName } from "../../core/models.js";
import type { InteractivePanel } from "../interactive-panel.js";
import {
  colorEvent,
  renderWaitingIndicator,
  section,
  truncate,
  wrap,
} from "./primitives.js";
import type { ContentRenderer, Section } from "./layout.js";
import { renderUnifiedFrame } from "./layout.js";
import { renderSteeringUsageBar } from "./bars.js";

/** Everything the steering frame needs to render, produced fresh each tick. */
export interface SteeringViewData {
  /** The ephemeral ticker heartbeat — elapsed, tool count, cost, current reasoning snippet. */
  statusLine: string;
  /** Persistent scrollback of discrete events (tool uses, retries, nudges). */
  events: SteeringEvent[];
  /** Optional context read from disk at setSteering() time. */
  context?: SteeringContext;
  /** Wall-clock ms the steering phase started, for the live elapsed indicator. */
  startedAt?: number;
}

function renderLastWave(out: string[], w: number, lw: WaveSummary): void {
  section(out, w, `Wave ${lw.wave + 1} summary`);
  const done = lw.tasks.filter(t => t.status === "done").length;
  const failed = lw.tasks.filter(t => t.status === "error").length;
  const running = lw.tasks.filter(t => t.status === "running").length;
  const parts: string[] = [];
  if (done > 0) parts.push(chalk.green(`\u2713 ${done} done`));
  if (failed > 0) parts.push(chalk.red(`\u2717 ${failed} failed`));
  if (running > 0) parts.push(chalk.blue(`~ ${running} running`));
  if (parts.length === 0) parts.push(chalk.dim("(no tasks)"));
  out.push("  " + parts.join("  "));
  const show = lw.tasks.slice(0, 5);
  for (const t of show) {
    const icon = t.status === "done" ? chalk.green("\u2713")
      : t.status === "error" ? chalk.red("\u2717")
      : t.status === "running" ? chalk.blue("~")
      : chalk.gray("\u00b7");
    const line = t.prompt.replace(/\n/g, " ");
    out.push(`    ${icon} ${chalk.dim(truncate(line, w - 8))}`);
  }
  if (lw.tasks.length > 5) out.push(chalk.dim(`    \u2026 + ${lw.tasks.length - 5} more`));
}

function renderStatusBlock(out: string[], w: number, status: string): void {
  const lines = status.trim().split("\n").filter(l => l.trim()).slice(0, 6);
  if (lines.length === 0) return;
  section(out, w, "Status");
  const indent = "  ";
  const maxW = w - indent.length;
  for (const ln of lines) {
    for (const wl of wrap(ln.trim(), maxW)) out.push(`${indent}${chalk.dim(wl)}`);
  }
}

export function renderSteeringFrame(
  runInfo: RunInfo,
  data: SteeringViewData,
  showHotkeys: boolean,
  rlGetter?: RLGetter,
  maxRows?: number,
  panel?: InteractivePanel,
): string {
  const totalUsed = runInfo.accCompleted + runInfo.accFailed;
  const ctx = data.context;

  const content: ContentRenderer = {
    sections(): Section[] {
      const secs: Section[] = [];
      const ww = Math.max((process.stdout.columns ?? 80) || 80, 60);

      // Objective (undecorated — raw line)
      if (ctx?.objective) {
        const obj = ctx.objective.replace(/\s+/g, " ").trim();
        secs.push({ title: "", rows: [
          `  ${chalk.bold.white("Objective")}  ${chalk.dim(truncate(obj, ww - 15))}`,
          "",
        ]});
      }

      // Status (decorated via renderStatusBlock)
      if (ctx?.status) {
        const statusRows: string[] = [];
        renderStatusBlock(statusRows, ww, ctx.status);
        if (statusRows.length > 0) {
          statusRows.push("");
          secs.push({ title: "", rows: statusRows });
        }
      }

      // Last wave (decorated via renderLastWave)
      if (ctx?.lastWave && ctx.lastWave.tasks.length > 0) {
        const lwRows: string[] = [];
        renderLastWave(lwRows, ww, ctx.lastWave);
        lwRows.push("");
        secs.push({ title: "", rows: lwRows });
      }

      // Planner activity (decorated)
      const plannerRows: string[] = [];
      const events = data.events.slice(-15);
      const plannerModel = rlGetter ? rlGetter().model : runInfo.model;
      const plannerModelTag = plannerModel ? chalk.dim(` \u00b7 ${modelDisplayName(plannerModel)}`) : "";
      const started = data.startedAt ?? Date.now();
      if (events.length === 0) {
        plannerRows.push("  " + renderWaitingIndicator("Planner thinking", started, { style: "thinking" }));
      } else {
        for (const e of events) {
          const t = new Date(e.time).toLocaleTimeString("en", { hour12: false });
          const arrowIdx = e.text.indexOf(" \u2192 ");
          if (arrowIdx > 0 && arrowIdx < 30) {
            const toolName = e.text.slice(0, arrowIdx);
            const target = e.text.slice(arrowIdx + 3);
            plannerRows.push(chalk.gray(`  ${t} `) + chalk.magenta("[plan] ") + chalk.yellow(toolName));
            plannerRows.push(chalk.dim(`      ${truncate(target, ww - 10)}`));
          } else {
            plannerRows.push(chalk.gray(`  ${t} `) + chalk.magenta("[plan] ") + colorEvent(truncate(e.text, ww - 22)));
          }
        }
      }
      secs.push({ title: `Planner activity${plannerModelTag}`, rows: plannerRows });

      // Status line: animated spinner + live ticker text + elapsed time, so the
      // phase never looks frozen even when the planner goes minutes without emitting.
      const liveClean = data.statusLine.replace(/\n/g, " ");
      const liveLabel = truncate(liveClean || "thinking\u2026", Math.max(10, ww - 24));
      secs.push({ title: "", rows: [`  ${renderWaitingIndicator(liveLabel, started, { style: "thinking" })}`] });

      return secs;
    },
  };

  const usageBarRender = rlGetter
    ? (out: string[], w: number) => {
        const rl = rlGetter();
        if (rl && (rl.utilization > 0 || rl.windows.size > 0 || (rl.contextTokens ?? 0) > 0)) {
          renderSteeringUsageBar(out, w, rl);
        }
      }
    : undefined;

  let hotkeyRow: string | undefined;
  const extraFooterRows: string[] = [];
  if (showHotkeys) {
    const pending = runInfo?.pendingSteer ?? 0;
    const chip = pending > 0 ? chalk.cyan(`  \u270E ${pending} steer queued`) : "";
    const panelChip = panel?.visible ? chalk.green(`  [Ctrl-O] ${panel.state.expanded ? "collapse" : "expand"}`) : "";
    hotkeyRow = chalk.dim("  [s] settings  [i] inject  [q] stop") + chip + panelChip;
  }

  return renderUnifiedFrame({
    model: runInfo.model,
    phase: chalk.magenta(`STEERING \u2192 wave ${runInfo.waveNum + 2}`),
    barPct: runInfo.sessionsBudget > 0 ? totalUsed / runInfo.sessionsBudget : 0,
    barLabel: `${totalUsed}/${runInfo.sessionsBudget}`,
    active: 0,
    queued: 0,
    startedAt: runInfo.startedAt,
    totalIn: runInfo.accIn,
    totalOut: runInfo.accOut,
    totalCost: runInfo.accCost,
    waveNum: runInfo.waveNum,
    sessionsUsed: totalUsed,
    sessionsBudget: runInfo.sessionsBudget,
    remaining: runInfo.remaining,
    usageBarRender,
    content,
    hotkeyRow,
    extraFooterRows,
    maxRows,
  });
}
