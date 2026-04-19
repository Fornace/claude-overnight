// Header bars rendered inside the Ink tree.
//
// Three possible bars per phase — RL (rate-limit utilization), Extra (overage
// budget), and Ctx (context fullness). The run phase reads live Swarm state,
// steering phase reads a single planner RL snapshot. Each bar dims/hides only
// when its signal is absent; when present it always shows a label so the user
// can read the numeric pct/eta at a glance.

import React from "react";
import { Text, Box } from "ink";
import chalk from "chalk";
import type { Swarm } from "../swarm/swarm.js";
import { RATE_LIMIT_WINDOW_SHORT } from "../core/types.js";
import type { AITurn, RLGetter } from "../core/types.js";
import { getModelCapability, modelDisplayName } from "../core/models.js";
import { allTurns, focusedTurn } from "../core/turns.js";
import { contextFillInfo, fmtTokens, renderWaitingIndicator } from "./primitives.js";

const BAR_W = 30;

function fillBar(pct: number, filledColor: (s: string) => string, capMark = -1): string {
  const filled = Math.round(pct * BAR_W);
  let out = "";
  for (let i = 0; i < BAR_W; i++) {
    if (i === capMark) out += chalk.yellow("\u2502");
    else if (i < filled) out += filledColor("\u2588");
    else out += chalk.gray("\u2591");
  }
  return out;
}

function pctColor(pct: number): (s: string) => string {
  if (pct > 0.9) return chalk.red;
  if (pct > 0.75) return chalk.yellow;
  return chalk.blue;
}

function peakAgentContext(swarm: Swarm): { tokens: number; safe: number; agentId: number; model: string } | null {
  let best: { tokens: number; safe: number; agentId: number; model: string; ratio: number } | null = null;
  for (const a of swarm.agents) {
    if (a.status !== "running") continue;
    const tokens = a.contextTokens ?? 0;
    if (tokens <= 0) continue;
    const model = a.task.model || swarm.model || "unknown";
    const safe = getModelCapability(model).safeContext;
    const ratio = safe > 0 ? tokens / safe : 0;
    if (!best || ratio > best.ratio) best = { tokens, safe, agentId: a.id, model, ratio };
  }
  return best;
}

/** Build the run-phase usage bar rows as chalk strings (Ink renders ANSI fine). */
export function UsageBars({ swarm, selectedAgentId }: { swarm: Swarm; selectedAgentId?: number }): React.ReactElement | null {
  const rows: string[] = [];
  const windows = Array.from(swarm.rateLimitWindows.values());
  const rlPct = swarm.rateLimitUtilization;
  const hasRL = !(rlPct <= 0 && !swarm.rateLimitResetsAt && !swarm.cappedOut && swarm.rateLimitPaused <= 0 && windows.length === 0);

  const turns = allTurns();
  const cycleIdx = turns.length > 1 ? Math.floor(Date.now() / 4000) % turns.length : 0;
  let ctxTurn: AITurn | null = turns.length > 1 ? (turns[cycleIdx] || null) : null;
  const ft = focusedTurn();
  if (ft && (ft.contextTokens ?? 0) > 0) ctxTurn = ft;

  let ctxAgent: { tokens: number; safe: number; agentId: number; model: string } | null = null;
  if (!ctxTurn) {
    if (selectedAgentId != null) {
      const a = swarm.agents.find(x => x.id === selectedAgentId);
      if (a && (a.contextTokens ?? 0) > 0) {
        const model = a.task.model || swarm.model || "unknown";
        ctxAgent = { tokens: a.contextTokens ?? 0, safe: getModelCapability(model).safeContext, agentId: a.id, model };
      }
    }
    if (!ctxAgent) {
      const peak = peakAgentContext(swarm);
      if (peak) ctxAgent = peak;
    }
  }

  if (!hasRL && !ctxTurn && !ctxAgent) return null;

  const capFrac = swarm.usageCap;
  const capMark = capFrac != null && capFrac < 1 ? Math.round(capFrac * BAR_W) : -1;

  const renderRL = (pct: number, windowLabel?: string) => {
    const bar = fillBar(pct, pctColor(pct), capMark);
    let label = `${Math.round(pct * 100)}% used`;
    if (swarm.cappedOut) {
      label = swarm.extraUsageBudget != null
        ? chalk.red(`Budget $${swarm.extraUsageBudget} exhausted \u2014 finishing active`)
        : chalk.yellow(`Capped at ${capFrac != null ? Math.round(capFrac * 100) : 100}% \u2014 finishing active`);
    } else if (swarm.rateLimitPaused > 0 || (swarm.rateLimitResetsAt && swarm.rateLimitResetsAt > Date.now())) {
      const mcw = swarm.mostConstrainedWindow();
      const when = (mcw?.resetsAt && mcw.resetsAt > Date.now()) ? mcw.resetsAt
        : (swarm.rateLimitResetsAt && swarm.rateLimitResetsAt > Date.now()) ? swarm.rateLimitResetsAt
        : undefined;
      const winName = mcw ? (RATE_LIMIT_WINDOW_SHORT[mcw.type] ?? mcw.type.replace(/_/g, " ")) : undefined;
      const base = winName ? `Anthropic ${winName} limit hit` : `Rate limited`;
      const hint = swarm.rateLimitPaused > 0 ? `${swarm.rateLimitPaused} waiting` : undefined;
      const since = swarm.rateLimitBlockedSince ?? Date.now();
      label = renderWaitingIndicator(base, since, { eta: when, hint, style: "wait" });
    }
    if (swarm.isUsingOverage && !swarm.cappedOut) label += chalk.red(" [OVERAGE]");
    const prefix = windowLabel ? chalk.dim(windowLabel.padEnd(6)) : chalk.dim("RL    ");
    let row = `  ${prefix}${bar}  ${label}`;
    if (windowLabel) {
      const dots = windows.map((_, i) => i === (Math.floor(Date.now() / 3000) % windows.length) ? "\u25CF" : "\u25CB").join("");
      row += chalk.dim(`  ${dots}`);
    }
    rows.push(row);
  };

  if (hasRL) {
    if (windows.length > 1) {
      const win = windows[Math.floor(Date.now() / 3000) % windows.length];
      const shortName = RATE_LIMIT_WINDOW_SHORT[win.type] ?? win.type.replace(/_/g, " ");
      renderRL(win.utilization, shortName);
    } else {
      renderRL(rlPct);
    }
  }

  if (swarm.isUsingOverage && swarm.extraUsageBudget != null && swarm.extraUsageBudget > 0) {
    const pct = Math.min(1, swarm.overageCostUsd / swarm.extraUsageBudget);
    const bar = fillBar(pct, pct > 0.9 ? chalk.red : pct > 0.75 ? chalk.yellow : chalk.magenta);
    const label = swarm.cappedOut
      ? chalk.red(`$${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget} \u2014 budget hit`)
      : `$${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget}`;
    rows.push(`  ${chalk.dim("Extra ")}${bar}  ${label}`);
  }

  if (ctxTurn) {
    const mdl = ctxTurn.model ?? "unknown";
    const safe = getModelCapability(mdl).safeContext;
    const tok = ctxTurn.contextTokens ?? 0;
    const { pct, color } = contextFillInfo(tok, safe);
    const filled = Math.min(BAR_W, Math.round((pct / 100) * BAR_W));
    const bar = color("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(BAR_W - filled));
    let row = `  ${chalk.dim("Ctx   ")}${bar}  ${fmtTokens(tok)}/${fmtTokens(safe)} safe  ${chalk.dim(`${ctxTurn.label} \u00b7 ${modelDisplayName(mdl)}`)}`;
    if (turns.length > 1) {
      const dots = turns.map((t, i) => {
        const ch = t.status === "running" ? "\u25CF" : t.status === "done" ? "\u25CB" : "\u25D0";
        return i === cycleIdx ? chalk.cyan(ch) : chalk.dim(ch);
      }).join("");
      row += chalk.dim(`  ${dots}`);
    }
    rows.push(row);
  } else if (ctxAgent) {
    const { pct, color } = contextFillInfo(ctxAgent.tokens, ctxAgent.safe);
    const filled = Math.min(BAR_W, Math.round((pct / 100) * BAR_W));
    const bar = color("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(BAR_W - filled));
    const who = selectedAgentId != null && ctxAgent.agentId === selectedAgentId ? `agent ${ctxAgent.agentId}` : `peak a${ctxAgent.agentId}`;
    rows.push(`  ${chalk.dim("Ctx   ")}${bar}  ${fmtTokens(ctxAgent.tokens)}/${fmtTokens(ctxAgent.safe)} safe  ${chalk.dim(`${who} \u00b7 ${modelDisplayName(ctxAgent.model)}`)}`);
  }

  return (
    <Box flexDirection="column">
      {rows.map((r, i) => <Text key={i}>{r}</Text>)}
    </Box>
  );
}

/** Steering-phase single-planner RL + Ctx bars. */
export function SteeringBars({ rl }: { rl: ReturnType<RLGetter> }): React.ReactElement | null {
  const rows: string[] = [];
  const hasRL = rl.utilization > 0 || rl.windows.size > 0 || (rl.resetsAt && rl.resetsAt > Date.now());

  const renderRL = (pct: number, windowLabel?: string) => {
    const bar = fillBar(pct, pctColor(pct));
    let label = `${Math.round(pct * 100)}% used`;
    if (rl.isUsingOverage) label += chalk.red(" [EXTRA USAGE]");
    if (rl.resetsAt && rl.resetsAt > Date.now()) {
      label = renderWaitingIndicator("Waiting for reset", undefined, { eta: rl.resetsAt, style: "warn" });
    }
    const prefix = windowLabel ? chalk.dim(windowLabel.padEnd(6)) : chalk.dim("RL    ");
    rows.push(`  ${prefix}${bar}  ${label}`);
  };

  if (hasRL) {
    if (rl.windows.size > 1) {
      const wins = Array.from(rl.windows.values());
      const idx = Math.floor(Date.now() / 3000) % wins.length;
      renderRL(wins[idx].utilization, wins[idx].type.replace(/_/g, " ").slice(0, 5));
    } else {
      renderRL(rl.utilization);
    }
  }

  if ((rl.contextTokens ?? 0) > 0 && rl.model) {
    const safe = getModelCapability(rl.model).safeContext;
    const tok = rl.contextTokens ?? 0;
    const { pct, color } = contextFillInfo(tok, safe);
    const filled = Math.min(BAR_W, Math.round((pct / 100) * BAR_W));
    const bar = color("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(BAR_W - filled));
    rows.push(`  ${chalk.dim("Ctx   ")}${bar}  ${fmtTokens(tok)}/${fmtTokens(safe)} safe  ${chalk.dim(`planner \u00b7 ${modelDisplayName(rl.model)}`)}`);
  }

  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => <Text key={i}>{r}</Text>)}
    </Box>
  );
}
