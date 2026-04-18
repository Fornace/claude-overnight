// The steering-phase body — objective, status, last-wave recap, planner
// activity, and the live ticker heartbeat.

import React from "react";
import { Text, Box } from "ink";
import chalk from "chalk";
import type { WaveSummary, RLGetter } from "../core/types.js";
import type { SteeringContext, SteeringEvent, RunInfo } from "./types.js";
import { modelDisplayName } from "../core/models.js";
import { colorEvent, renderWaitingIndicator, truncate, wrap } from "./primitives.js";

function terminalWidth(): number { return Math.max((process.stdout.columns ?? 80) || 80, 60); }

function divider(w: number, title: string): string {
  const inner = ` ${title} `;
  const dashW = Math.max(3, Math.min(w - 6, 96) - inner.length);
  return chalk.gray("  \u2500\u2500\u2500" + inner + "\u2500".repeat(dashW));
}

function lastWaveRows(w: number, lw: WaveSummary): string[] {
  const out: string[] = [divider(w, `Wave ${lw.wave + 1} summary`)];
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
  return out;
}

function statusRows(w: number, status: string): string[] {
  const lines = status.trim().split("\n").filter(l => l.trim()).slice(0, 6);
  if (lines.length === 0) return [];
  const out: string[] = [divider(w, "Status")];
  const indent = "  ";
  const maxW = w - indent.length;
  for (const ln of lines) {
    for (const wl of wrap(ln.trim(), maxW)) out.push(`${indent}${chalk.dim(wl)}`);
  }
  return out;
}

function plannerRows(w: number, events: SteeringEvent[], startedAt: number, plannerModel?: string): string[] {
  const plannerModelTag = plannerModel ? chalk.dim(` \u00b7 ${modelDisplayName(plannerModel)}`) : "";
  const out: string[] = [divider(w, `Planner activity${plannerModelTag}`)];
  const show = events.slice(-15);
  if (show.length === 0) {
    out.push("  " + renderWaitingIndicator("Planner thinking", startedAt, { style: "thinking" }));
    return out;
  }
  for (const e of show) {
    const t = new Date(e.time).toLocaleTimeString("en", { hour12: false });
    const arrowIdx = e.text.indexOf(" \u2192 ");
    if (arrowIdx > 0 && arrowIdx < 30) {
      const toolName = e.text.slice(0, arrowIdx);
      const target = e.text.slice(arrowIdx + 3);
      out.push(chalk.gray(`  ${t} `) + chalk.magenta("[plan] ") + chalk.yellow(toolName));
      out.push(chalk.dim(`      ${truncate(target, w - 10)}`));
    } else {
      out.push(chalk.gray(`  ${t} `) + chalk.magenta("[plan] ") + colorEvent(truncate(e.text, w - 22)));
    }
  }
  return out;
}

interface Props {
  runInfo: RunInfo;
  context?: SteeringContext;
  events: SteeringEvent[];
  startedAt: number;
  statusLine: string;
  rlGetter?: RLGetter;
}

export function SteeringBody({ runInfo, context, events, startedAt, statusLine, rlGetter }: Props): React.ReactElement {
  const w = terminalWidth();
  const rows: string[] = [];

  if (context?.objective) {
    const obj = context.objective.replace(/\s+/g, " ").trim();
    rows.push(`  ${chalk.bold.white("Objective")}  ${chalk.dim(truncate(obj, w - 15))}`);
    rows.push("");
  }

  if (context?.status) {
    const sr = statusRows(w, context.status);
    if (sr.length > 0) { rows.push(...sr); rows.push(""); }
  }

  if (context?.lastWave && context.lastWave.tasks.length > 0) {
    rows.push(...lastWaveRows(w, context.lastWave));
    rows.push("");
  }

  const plannerModel = rlGetter ? rlGetter().model : runInfo.model;
  rows.push(...plannerRows(w, events, startedAt, plannerModel));

  const liveClean = statusLine.replace(/\n/g, " ");
  const liveLabel = truncate(liveClean || "thinking\u2026", Math.max(10, w - 24));
  rows.push(`  ${renderWaitingIndicator(liveLabel, startedAt, { style: "thinking" })}`);

  return (
    <Box flexDirection="column">
      {rows.map((r, i) => <Text key={i}>{r}</Text>)}
    </Box>
  );
}
