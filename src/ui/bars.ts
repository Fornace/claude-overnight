// Quantitative bars drawn inside the frame header — rate-limit utilization,
// overage budget, and context fullness.
//
// These are the only renderers that reach into live Swarm / planner state, so
// keep everything Swarm-aware here and out of the pure primitives.

import chalk from "chalk";
import type { Swarm } from "../swarm/swarm.js";
import { RATE_LIMIT_WINDOW_SHORT } from "../core/types.js";
import type { AITurn, RLGetter } from "../core/types.js";
import { getModelCapability, modelDisplayName } from "../core/models.js";
import { allTurns, focusedTurn } from "../core/turns.js";
import { fmtTokens, renderWaitingIndicator } from "./primitives.js";

/** Context-fill percentage and color function for a token count vs safe limit.
 *  Green under 50%, yellow past 50%, red past 80%. Exported so the run-phase
 *  frame can color an agent's detail row to match the header gauge. */
export function contextFillInfo(tokens: number, safe: number): { pct: number; color: typeof chalk } {
  const pct = safe > 0 ? Math.round((tokens / safe) * 100) : 0;
  const color = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
  return { pct, color };
}

function drawContextBar(out: string[], w: number, tokens: number, safe: number, label: string): void {
  const barW = Math.min(30, w - 40);
  const { pct, color } = contextFillInfo(tokens, safe);
  const filled = Math.round((pct / 100) * barW);
  const bar = color("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(barW - filled));
  const prefix = chalk.dim("Ctx   ");
  out.push(`  ${prefix}${bar}  ${label}`);
}

/** Pick the running agent with the highest context-fill ratio; returns
 *  {tokens, safe, agentId, model} or null. Used as the default source for
 *  the context gauge when no agent is explicitly selected. */
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

// ── Run-phase usage bars ──
//
// Three possible bars, drawn only when their signal is present:
//   RL     — Anthropic rate-limit window utilization
//   Extra  — pay-as-you-go overage dollars vs approved budget
//   Ctx    — token fill of the currently-focused turn or agent
//
// When multiple RL windows are active we rotate through them on a slow timer
// so every window gets visible airtime without stacking bars vertically.

export function renderUsageBars(out: string[], w: number, swarm: Swarm, selectedAgentId?: number): void {
  const windows = Array.from(swarm.rateLimitWindows.values());
  const rlPct = swarm.rateLimitUtilization;
  const hasRL = !(rlPct <= 0 && !swarm.rateLimitResetsAt && !swarm.cappedOut && swarm.rateLimitPaused <= 0 && windows.length === 0);

  // Context fullness bar — use the turns registry.
  // Prefer the focused turn (from arrow-key navigation or auto-cycle), fall back
  // to the selected agent's context, then the peak running agent.
  const turns = allTurns();
  const cycleIdx = turns.length > 1 ? Math.floor(Date.now() / 4000) % turns.length : 0;
  let ctxTurn: AITurn | null = turns.length > 1 ? (turns[cycleIdx] || null) : null;
  const ft = focusedTurn();
  if (ft && (ft.contextTokens ?? 0) > 0) ctxTurn = ft;
  // Fall back to selected agent or peak agent
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

  if (!hasRL && !ctxTurn && !ctxAgent) return;

  const barW = Math.min(30, w - 40);
  const capFrac = swarm.usageCap;
  const capMark = capFrac != null && capFrac < 1 ? Math.round(capFrac * barW) : -1;

  const renderBar = (pct: number, windowLabel?: string) => {
    let barStr = "";
    const filled = Math.round(pct * barW);
    for (let i = 0; i < barW; i++) {
      if (i === capMark) barStr += chalk.yellow("\u2502");
      else if (i < filled) barStr += pct > 0.9 ? chalk.red("\u2588") : pct > 0.75 ? chalk.yellow("\u2588") : chalk.blue("\u2588");
      else barStr += chalk.gray("\u2591");
    }
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
    out.push(`  ${prefix}${barStr}  ${label}`);
  };

  if (!hasRL) {
    // Skip the Anthropic RL bar entirely when there's no signal — just show the context bar below.
  } else if (windows.length > 1) {
    const cycleIdx = Math.floor(Date.now() / 3000) % windows.length;
    const win = windows[cycleIdx];
    const shortName = RATE_LIMIT_WINDOW_SHORT[win.type] ?? win.type.replace(/_/g, " ");
    renderBar(win.utilization, shortName);
    const dots = windows.map((_, i) => i === cycleIdx ? "\u25CF" : "\u25CB").join("");
    out[out.length - 1] += chalk.dim(`  ${dots}`);
  } else {
    renderBar(rlPct);
  }

  // Extra usage budget bar
  if (swarm.isUsingOverage && swarm.extraUsageBudget != null && swarm.extraUsageBudget > 0) {
    const pct = Math.min(1, swarm.overageCostUsd / swarm.extraUsageBudget);
    const filled = Math.round(pct * barW);
    let barStr = "";
    for (let i = 0; i < barW; i++) {
      if (i < filled) barStr += pct > 0.9 ? chalk.red("\u2588") : pct > 0.75 ? chalk.yellow("\u2588") : chalk.magenta("\u2588");
      else barStr += chalk.gray("\u2591");
    }
    const label = swarm.cappedOut
      ? chalk.red(`$${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget} \u2014 budget hit`)
      : `$${swarm.overageCostUsd.toFixed(2)}/$${swarm.extraUsageBudget}`;
    out.push(`  ${chalk.dim("Extra ")}${barStr}  ${label}`);
  }

  // Context fullness bar
  if (ctxTurn) {
    const mdl = ctxTurn.model ?? "unknown";
    const safe = getModelCapability(mdl).safeContext;
    const tok = ctxTurn.contextTokens ?? 0;
    const label = `${fmtTokens(tok)}/${fmtTokens(safe)} safe  ${chalk.dim(`${ctxTurn.label} \u00b7 ${modelDisplayName(mdl)}`)}`;
    drawContextBar(out, w, tok, safe, label);
    if (turns.length > 1) {
      const dots = turns.map((t, i) => {
        const ch = t.status === "running" ? "\u25CF" : t.status === "done" ? "\u25CB" : "\u25D0";
        return i === cycleIdx ? chalk.cyan(ch) : chalk.dim(ch);
      }).join("");
      out[out.length - 1] += chalk.dim(`  ${dots}`);
    }
  } else if (ctxAgent) {
    const who = selectedAgentId != null && ctxAgent.agentId === selectedAgentId ? `agent ${ctxAgent.agentId}` : `peak a${ctxAgent.agentId}`;
    const label = `${fmtTokens(ctxAgent.tokens)}/${fmtTokens(ctxAgent.safe)} safe  ${chalk.dim(`${who} \u00b7 ${modelDisplayName(ctxAgent.model)}`)}`;
    drawContextBar(out, w, ctxAgent.tokens, ctxAgent.safe, label);
  }
}

// ── Steering-phase usage bar ──
//
// The steering phase only has a single planner turn, so this renderer reads
// from an `RLGetter` snapshot rather than a full Swarm instance.

export function renderSteeringUsageBar(out: string[], w: number, rl: ReturnType<RLGetter>): void {
  const rlBarW = Math.min(30, w - 40);
  const draw = (pct: number, label?: string) => {
    let barStr = "";
    const f = Math.round(pct * rlBarW);
    for (let i = 0; i < rlBarW; i++) {
      if (i < f) barStr += pct > 0.9 ? chalk.red("\u2588") : pct > 0.75 ? chalk.yellow("\u2588") : chalk.blue("\u2588");
      else barStr += chalk.gray("\u2591");
    }
    let lbl = `${Math.round(pct * 100)}% used`;
    if (rl.isUsingOverage) lbl += chalk.red(" [EXTRA USAGE]");
    if (rl.resetsAt && rl.resetsAt > Date.now()) {
      lbl = renderWaitingIndicator("Waiting for reset", undefined, { eta: rl.resetsAt, style: "warn" });
    }
    const prefix = label ? chalk.dim(label.padEnd(6)) : chalk.dim("RL    ");
    out.push(`  ${prefix}${barStr}  ${lbl}`);
  };
  const hasRL = rl.utilization > 0 || rl.windows.size > 0 || (rl.resetsAt && rl.resetsAt > Date.now());
  if (hasRL) {
    if (rl.windows.size > 1) {
      const wins = Array.from(rl.windows.values());
      const idx = Math.floor(Date.now() / 3000) % wins.length;
      draw(wins[idx].utilization, wins[idx].type.replace(/_/g, " ").slice(0, 5));
    } else {
      draw(rl.utilization);
    }
  }
  if ((rl.contextTokens ?? 0) > 0 && rl.model) {
    const safe = getModelCapability(rl.model).safeContext;
    const tok = rl.contextTokens ?? 0;
    const label = `${fmtTokens(tok)}/${fmtTokens(safe)} safe  ${chalk.dim(`planner \u00b7 ${modelDisplayName(rl.model)}`)}`;
    drawContextBar(out, w, tok, safe, label);
  }
}
