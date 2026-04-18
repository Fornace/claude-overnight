// The run-phase body — agent table, detail panel, merges, event log.

import React from "react";
import { Text, Box } from "ink";
import chalk from "chalk";
import type { Swarm } from "../swarm/swarm.js";
import type { AgentState } from "../core/types.js";
import { getModelCapability, modelDisplayName } from "../core/models.js";
import { contextFillInfo, colorEvent, fmtDur, fmtTokens, padVisible, renderWaitingIndicator, spinnerFrame, truncate } from "./primitives.js";

const COL_ID_W = 3;
const COL_MODEL_W = 18;
const COL_STATUS_W = 12;

function terminalWidth(): number { return Math.max((process.stdout.columns ?? 80) || 80, 60); }

function divider(w: number, title = ""): string {
  if (title) {
    const inner = ` ${title} `;
    const dashW = Math.max(3, Math.min(w - 6, 96) - inner.length);
    return chalk.gray("  \u2500\u2500\u2500" + inner + "\u2500".repeat(dashW));
  }
  return chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, 100)));
}

function taskColumnWidth(w: number): number {
  return Math.max(20, Math.min(36, w - 50 - COL_MODEL_W - 6));
}

function fmtRow(a: AgentState, w: number, selected: boolean, fallbackModel?: string): string {
  const id = selected ? chalk.cyan.bold(String(a.id).padStart(COL_ID_W)) : String(a.id).padStart(COL_ID_W);
  const mdl = modelDisplayName(a.model || a.task.model || fallbackModel || "unknown");
  const modelStr = truncate(mdl, COL_MODEL_W).padEnd(COL_MODEL_W);
  const elapsed = a.status === "running" && a.startedAt ? " " + chalk.dim(fmtDur(Date.now() - a.startedAt)) : "";
  const dot = spinnerFrame("dots");
  const rawIcon = a.status === "running"
    ? (a.blockedAt ? chalk.yellow(`${dot} blk`) : chalk.blue(`${dot} run`)) + elapsed
    : a.status === "paused" ? chalk.yellow("\u23F8 paused")
    : a.status === "done" ? chalk.green("\u2713 done") : chalk.red("\u2717 err");
  const icon = padVisible(rawIcon, COL_STATUS_W);
  const taskW = taskColumnWidth(w);
  const task = truncate(a.task.prompt, taskW).padEnd(taskW);

  let action: string;
  if (a.blockedAt) {
    action = chalk.yellow(`rate-limited ${fmtDur(Date.now() - a.blockedAt)}`);
  } else if (a.currentTool) {
    action = chalk.yellow(a.currentTool);
  } else if (a.status === "running") {
    action = chalk.dim(truncate(a.lastText || "...", 24));
  } else if (a.status === "paused") {
    const dur = fmtDur(Date.now() - (a.startedAt || Date.now()));
    action = chalk.yellow(`paused ${dur}`);
  } else if (a.status === "done") {
    const dur = fmtDur((a.finishedAt || Date.now()) - (a.startedAt || Date.now()));
    const cost = a.costUsd != null ? ` $${a.costUsd.toFixed(3)}` : "";
    const files = a.filesChanged != null && a.filesChanged > 0 ? chalk.dim(` ${a.filesChanged}f`) : "";
    action = chalk.dim(`${dur}${cost}${files}`);
  } else {
    action = chalk.red(truncate(a.error || "error", 24));
  }
  return `  ${id}  ${modelStr}  ${icon}  ${task}  ${action}`;
}

function agentTable(swarm: Swarm, selectedAgentId?: number): string[] {
  const w = terminalWidth();
  const running = swarm.agents.filter(a => a.status === "running");
  const finished = swarm.agents.filter(a => a.status !== "running");
  const showFinished = finished.slice(-Math.max(2, 12 - running.length));
  const show = [...running, ...showFinished];
  if (show.length === 0) return [];
  const taskW = taskColumnWidth(w);
  const header =
    "  " + "#".padEnd(COL_ID_W) +
    "  " + "Model".padEnd(COL_MODEL_W) +
    "  " + "Status".padEnd(COL_STATUS_W) +
    "  " + "Task".padEnd(taskW) +
    "  " + "Action";
  const rows: string[] = [
    chalk.gray(header),
    divider(w),
  ];
  for (const a of show) rows.push(fmtRow(a, w, a.id === (selectedAgentId ?? -1), swarm.model));
  if (swarm.pending > 0) rows.push(chalk.gray(`  ... + ${swarm.pending} queued`));
  return rows;
}

function detailRows(swarm: Swarm, id: number): string[] {
  const agent = swarm.agents.find(a => a.id === id);
  if (!agent) return [];
  const w = terminalWidth();
  const rows: string[] = [];
  const taskLines = agent.task.prompt.split("\n");
  const maxTaskLines = Math.min(6, taskLines.length);
  for (let i = 0; i < maxTaskLines; i++) {
    rows.push(`  ${chalk.dim(truncate(taskLines[i].trim(), w - 6))}`);
  }
  if (taskLines.length > maxTaskLines) rows.push(chalk.dim(`  \u2026 + ${taskLines.length - maxTaskLines} more lines`));
  const meta: string[] = [];
  if (agent.currentTool) meta.push(chalk.yellow(`tool: ${agent.currentTool}`));
  if (agent.lastText) meta.push(chalk.dim(truncate(agent.lastText, 60)));
  if (agent.filesChanged != null) meta.push(chalk.dim(`${agent.filesChanged} files`));
  if (agent.costUsd != null) meta.push(chalk.yellow(`$${agent.costUsd.toFixed(3)}`));
  if (agent.toolCalls > 0) meta.push(chalk.dim(`${agent.toolCalls} tools`));
  const tok = agent.peakContextTokens ?? agent.contextTokens ?? 0;
  if (tok > 0) {
    const mdl = agent.task.model || swarm.model || "unknown";
    const safe = getModelCapability(mdl).safeContext;
    const { pct, color } = contextFillInfo(tok, safe);
    meta.push(color(`ctx ${fmtTokens(tok)}/${fmtTokens(safe)} (${pct}%)`));
  }
  if (meta.length > 0) rows.push(`  ${meta.join(chalk.dim("  \u00b7 "))}`);
  return [divider(w, `Agent ${id} detail \u00b7 [\u2190] close`), ...rows];
}

function mergeRows(swarm: Swarm): string[] {
  if (swarm.mergeResults.length === 0) return [];
  const w = terminalWidth();
  const rows: string[] = [divider(w, "Merges")];
  for (const mr of swarm.mergeResults) {
    const icon = mr.ok ? chalk.green("\u2713") : chalk.red("\u2717");
    const info = mr.ok ? chalk.dim(`${mr.filesChanged} file(s)`) : chalk.red(truncate(mr.error || "conflict", 40));
    rows.push(`  ${icon} ${mr.branch}  ${info}`);
  }
  return rows;
}

function eventRows(swarm: Swarm): string[] {
  const w = terminalWidth();
  const rows: string[] = [divider(w, "Events")];
  const allDone = swarm.agents.length > 0 && swarm.agents.every(a => a.status !== "running");
  if (allDone && swarm.phase !== "done") {
    const phaseLabel = swarm.phase === "merging" ? "Merging branches" : "Finalizing wave";
    rows.push("  " + renderWaitingIndicator(phaseLabel, swarm.startedAt, { style: "thinking" }));
    rows.push("");
  }
  const logN = Math.min(12, swarm.logs.length);
  for (const entry of swarm.logs.slice(-logN)) {
    const t = new Date(entry.time).toLocaleTimeString("en", { hour12: false });
    const tag = entry.agentId < 0 ? chalk.magenta("[sys]") : chalk.cyan(`[${entry.agentId}]`);
    const arrowIdx = entry.text.indexOf(" \u2192 ");
    if (arrowIdx > 0 && arrowIdx < 20) {
      const toolName = entry.text.slice(0, arrowIdx);
      const target = entry.text.slice(arrowIdx + 3);
      rows.push(chalk.gray(`  ${t} `) + tag + ` ${chalk.yellow(toolName)}`);
      rows.push(chalk.dim(`      ${truncate(target, w - 10)}`));
    } else {
      rows.push(chalk.gray(`  ${t} `) + tag + ` ${colorEvent(truncate(entry.text, w - 22))}`);
    }
  }
  return rows;
}

export function RunBody({ swarm, selectedAgentId }: { swarm: Swarm; selectedAgentId?: number }): React.ReactElement {
  const lines = [
    ...agentTable(swarm, selectedAgentId),
    ...(selectedAgentId != null ? detailRows(swarm, selectedAgentId) : []),
    ...mergeRows(swarm),
    ...eventRows(swarm),
  ];

  // Rate-limited-all-workers warning, inlined above the footer area.
  const warnings: string[] = [];
  if (swarm.blocked > 0 && swarm.blocked === swarm.active) {
    warnings.push(chalk.yellow(`  all workers rate-limited \u2014 press [r] to skip`));
  }

  return (
    <Box flexDirection="column">
      {lines.map((r, i) => <Text key={i}>{r}</Text>)}
      {warnings.map((r, i) => <Text key={`w${i}`}>{r}</Text>)}
    </Box>
  );
}
