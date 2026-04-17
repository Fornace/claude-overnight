import chalk from "chalk";
import type { Swarm } from "./swarm.js";
import { RATE_LIMIT_WINDOW_SHORT } from "./types.js";
import type { AgentState, RLGetter, WaveSummary } from "./types.js";
import type { RunInfo, SteeringContext, SteeringEvent } from "./ui.js";
import { getModelCapability, modelDisplayName } from "./models.js";
import { InteractivePanel } from "./interactive-panel.js";

// ── Unified layout types ──

export interface Section {
  title: string;
  rows: string[];
  scrollable?: boolean;
  highlightKey?: string;
}

export interface ContentRenderer {
  /** Returns an array of sections to render in the content area */
  sections(): Section[];
}

const SPINNER = ["|", "/", "-", "\\"] as const;

// ── Shared helpers ──

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function colorEvent(text: string): string {
  if (text === "Done" || text.startsWith("Merged ") || text.startsWith("Committed ")) return chalk.green(text);
  if (text.startsWith("Rate:") || text.startsWith("Rate limited") || text.startsWith("Soft throttle")) return chalk.magenta(text);
  if (/error|fail|conflict/i.test(text)) return chalk.red(text);
  if (!text.includes(" ") && text.length <= 40) return chalk.yellow(text);
  return text;
}

// ── Header ──

function renderHeader(
  out: string[], w: number,
  p: {
    model?: string; phase: string; barPct: number; barLabel: string;
    active: number; blocked?: number; queued: number; startedAt: number;
    totalIn: number; totalOut: number; totalCost: number;
    waveNum: number; sessionsUsed: number; sessionsBudget: number; remaining: number;
  },
): void {
  const barW = Math.min(30, w - 50);
  const filled = Math.round(p.barPct * barW);
  const bar = chalk.green("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(barW - filled));
  const modelTag = p.model ? chalk.dim(` [${p.model}]`) : "";
  const phaseTag = p.phase ? " " + p.phase : "";

  const blocked = p.blocked ?? 0;
  const working = Math.max(0, p.active - blocked);
  const stuck = blocked > 0 && working === 0;
  const activeChip = p.active > 0
    ? (stuck ? chalk.yellow(`${p.active} blocked`) : chalk.cyan(`${working} active`) + (blocked > 0 ? chalk.yellow(` (${blocked} blocked)`) : ""))
    : "";

  out.push("");
  out.push(
    `  ${chalk.bold.white("CLAUDE OVERNIGHT")}${modelTag}${phaseTag}  ${bar}  ` +
      `${p.barLabel}  ` +
      (activeChip ? activeChip + "  " : "") +
      (p.queued > 0 ? chalk.gray(`${p.queued} queued`) + "  " : "") +
      chalk.gray(`\u23F1 ${fmtDur(Date.now() - p.startedAt)}`),
  );

  const tokIn = fmtTokens(p.totalIn);
  const tokOut = fmtTokens(p.totalOut);
  const costStr = p.totalCost > 0 ? chalk.yellow(`$${p.totalCost.toFixed(2)}`) : "";
  const waveLabel = p.waveNum >= 0 ? `wave ${p.waveNum + 1} \u00b7 ` : "";
  const sessionStr = chalk.dim(`  ${waveLabel}`) +
    chalk.white(`${p.sessionsUsed}/${p.sessionsBudget}`) +
    chalk.dim(` sessions \u00b7 ${p.remaining} left`);
  out.push(
    chalk.gray(`  \u2191 ${tokIn} in  \u2193 ${tokOut} out`) +
      (costStr ? `  ${costStr}` : "") + sessionStr,
  );
}

// ── Usage bars ──

/** Context-fill percentage and color function for a token count vs safe limit. */
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

/** Pick the running agent with the highest context-fill ratio; returns {tokens, safe, agentId} or null. */
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

function renderUsageBars(out: string[], w: number, swarm: Swarm, selectedAgentId?: number): void {
  const windows = Array.from(swarm.rateLimitWindows.values());
  const rlPct = swarm.rateLimitUtilization;
  const hasRL = !(rlPct <= 0 && !swarm.rateLimitResetsAt && !swarm.cappedOut && swarm.rateLimitPaused <= 0 && windows.length === 0);

  // Context bar — prefer the selected agent when detail view is open, else the peak running agent.
  let ctx: { tokens: number; safe: number; agentId: number; model: string } | null = null;
  if (selectedAgentId != null) {
    const a = swarm.agents.find(x => x.id === selectedAgentId);
    if (a && (a.contextTokens ?? 0) > 0) {
      const model = a.task.model || swarm.model || "unknown";
      ctx = { tokens: a.contextTokens ?? 0, safe: getModelCapability(model).safeContext, agentId: a.id, model };
    }
  }
  if (!ctx) ctx = peakAgentContext(swarm);

  if (!hasRL && !ctx) return;

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
      let txt = winName
        ? `Anthropic ${winName} limit hit`
        : `Rate limited`;
      if (when) {
        const waitSec = Math.ceil((when - Date.now()) / 1000);
        const mm = Math.floor(waitSec / 60), ss = waitSec % 60;
        txt += ` \u2014 resets in ${mm > 0 ? `${mm}m ${ss}s` : `${ss}s`}`;
      }
      if (swarm.rateLimitPaused > 0) txt += ` (${swarm.rateLimitPaused} waiting)`;
      label = chalk.yellow(txt);
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

  // Context fullness bar (per peak-running-agent or selected agent).
  if (ctx) {
    const who = selectedAgentId != null && ctx.agentId === selectedAgentId ? `agent ${ctx.agentId}` : `peak a${ctx.agentId}`;
    const label = `${fmtTokens(ctx.tokens)}/${fmtTokens(ctx.safe)} safe  ${chalk.dim(`${who} · ${modelDisplayName(ctx.model)}`)}`;
    drawContextBar(out, w, ctx.tokens, ctx.safe, label);
  }
}

// ── Unified frame renderer ──

export function renderUnifiedFrame(
  params: {
    // Header params
    model?: string;
    phase: string;
    barPct: number;
    barLabel: string;
    active?: number;
    blocked?: number;
    queued?: number;
    startedAt: number;
    totalIn: number;
    totalOut: number;
    totalCost: number;
    waveNum: number;
    sessionsUsed: number;
    sessionsBudget: number;
    remaining: number;
    // Usage bar params (optional)
    usageBarRender?: (out: string[], w: number) => void;
    // Content
    content: ContentRenderer;
    // Footer
    hotkeyRow?: string;
    extraFooterRows?: string[];
    // Layout budget — when set, content sections are trimmed so the total
    // frame never exceeds this many lines.  Header and footer are always
    // rendered in full; only the content area shrinks.
    maxRows?: number;
  },
): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);

  // ── Header (fixed) ──
  const header: string[] = [];
  renderHeader(header, w, {
    model: params.model,
    phase: params.phase,
    barPct: params.barPct,
    barLabel: params.barLabel,
    active: params.active ?? 0,
    blocked: params.blocked,
    queued: params.queued ?? 0,
    startedAt: params.startedAt,
    totalIn: params.totalIn,
    totalOut: params.totalOut,
    totalCost: params.totalCost,
    waveNum: params.waveNum,
    sessionsUsed: params.sessionsUsed,
    sessionsBudget: params.sessionsBudget,
    remaining: params.remaining,
  });
  if (params.usageBarRender) params.usageBarRender(header, w);
  header.push("");

  // ── Footer (fixed) ──
  const footer: string[] = [""];
  if (params.hotkeyRow) footer.push(params.hotkeyRow);
  if (params.extraFooterRows) for (const row of params.extraFooterRows) footer.push(row);
  footer.push("");

  // ── Content (elastic — shrinks to fit) ──
  const contentBudget = params.maxRows != null
    ? Math.max(0, params.maxRows - header.length - footer.length)
    : Infinity;

  const content: string[] = [];
  const sections = params.content.sections();
  for (const sec of sections) {
    if (content.length >= contentBudget) break;
    if (sec.title) section(content, w, sec.title);
    for (const row of sec.rows) {
      if (content.length >= contentBudget) break;
      content.push(row);
    }
  }

  const full = [...header, ...content, ...footer];
  if (params.maxRows != null && full.length > params.maxRows) {
    return full.slice(0, Math.max(0, params.maxRows)).join("\n");
  }
  return full.join("\n");
}

// ── Frame renderers ──

export function renderFrame(swarm: Swarm, showHotkeys: boolean, runInfo?: RunInfo, selectedAgentId?: number, maxRows?: number, panel?: InteractivePanel): string {
  const allDone = swarm.agents.length > 0 && swarm.agents.every(a => a.status !== "running");
  const doneTag = allDone && !swarm.aborted ? chalk.green("COMPLETE") : "";
  const stoppingTag = swarm.aborted ? chalk.yellow("STOPPING") : "";
  const pausedTag = swarm.paused ? chalk.yellow("PAUSED") : "";
  const stallTag = swarm.stallLevel >= 3 ? chalk.red("STALL") : swarm.stallLevel > 0 ? chalk.yellow(`STALL L${swarm.stallLevel}`) : "";
  const phaseLabel = swarm.phase === "planning" ? chalk.magenta("PLANNING")
    : swarm.phase === "merging" ? chalk.yellow("MERGING")
    : swarm.rateLimitPaused > 0 ? chalk.yellow("COOLING") : "";
  const phase = [phaseLabel, doneTag, pausedTag, stallTag, stoppingTag].filter(Boolean).join(" ");

  const waveUsed = swarm.completed + swarm.failed;

  const running = swarm.agents.filter(a => a.status === "running");
  const finished = swarm.agents.filter(a => a.status !== "running");
  const showFinished = finished.slice(-Math.max(2, 12 - running.length));
  const show = [...running, ...showFinished];

  const detailAgent = selectedAgentId != null
    ? swarm.agents.find(a => a.id === selectedAgentId)
    : undefined;

  const content: ContentRenderer = {
    sections(): Section[] {
      const secs: Section[] = [];

      // Expanded panel (debrief, ask, custom) — rendered as first section
      if (panel?.visible && panel.state.expanded) {
        const ww = Math.max((process.stdout.columns ?? 80) || 80, 60);
        const panelRows = maxRows != null ? Math.max(4, maxRows - 6) : 12;
        const lines = panel.renderExpanded(ww, panelRows);
        if (lines.length > 0) secs.push({ title: "", rows: lines });
      }

      // Agent table (undecorated  -- raw header + rows)
      if (show.length > 0) {
        const rows: string[] = [
          chalk.gray("  #   Status   Task" + " ".repeat(Math.max(1, (process.stdout.columns ?? 80) || 80, 60) - 56)) + "Action",
          chalk.gray("  " + "\u2500".repeat(Math.min(Math.max((process.stdout.columns ?? 80) || 80, 60) - 4, 100))),
        ];
        for (const a of show) rows.push(fmtRow(a, (process.stdout.columns ?? 80) || 80, a.id === (selectedAgentId ?? -1)));
        if (swarm.pending > 0) rows.push(chalk.gray(`  ... + ${swarm.pending} queued`));
        secs.push({ title: "", rows });
      }

      // Agent detail (decorated)
      if (detailAgent) {
        const rows: string[] = [];
        const taskLines = detailAgent.task.prompt.split("\n");
        const maxTaskLines = Math.min(6, taskLines.length);
        const ww = Math.max((process.stdout.columns ?? 80) || 80, 60);
        for (let i = 0; i < maxTaskLines; i++) {
          rows.push(`  ${chalk.dim(truncate(taskLines[i].trim(), ww - 6))}`);
        }
        if (taskLines.length > maxTaskLines) rows.push(chalk.dim(`  \u2026 + ${taskLines.length - maxTaskLines} more lines`));
        const meta: string[] = [];
        if (detailAgent.currentTool) meta.push(chalk.yellow(`tool: ${detailAgent.currentTool}`));
        if (detailAgent.lastText) meta.push(chalk.dim(truncate(detailAgent.lastText, 60)));
        if (detailAgent.filesChanged != null) meta.push(chalk.dim(`${detailAgent.filesChanged} files`));
        if (detailAgent.costUsd != null) meta.push(chalk.yellow(`$${detailAgent.costUsd.toFixed(3)}`));
        if (detailAgent.toolCalls > 0) meta.push(chalk.dim(`${detailAgent.toolCalls} tools`));
        if ((detailAgent.contextTokens ?? 0) > 0) {
          const mdl = detailAgent.task.model || swarm.model || "unknown";
          const safe = getModelCapability(mdl).safeContext;
          const tok = detailAgent.contextTokens ?? 0;
          const { pct, color } = contextFillInfo(tok, safe);
          meta.push(color(`ctx ${fmtTokens(tok)}/${fmtTokens(safe)} (${pct}%)`));
        }
        if (meta.length > 0) rows.push(`  ${meta.join(chalk.dim("  \u00b7 "))}`);
        secs.push({ title: `Agent ${detailAgent.id} detail \u00b7 [d] next \u00b7 [Esc] close`, rows });
      }

      // Merge results (undecorated)
      if (swarm.mergeResults.length > 0) {
        const ww = Math.max((process.stdout.columns ?? 80) || 80, 60);
        const rows: string[] = [chalk.gray("  \u2500\u2500\u2500 Merges " + "\u2500".repeat(Math.min(ww - 16, 90)))];
        for (const mr of swarm.mergeResults) {
          const icon = mr.ok ? chalk.green("\u2713") : chalk.red("\u2717");
          const info = mr.ok ? chalk.dim(`${mr.filesChanged} file(s)`) : chalk.red(truncate(mr.error || "conflict", 40));
          rows.push(`  ${icon} ${mr.branch}  ${info}`);
        }
        secs.push({ title: "", rows });
      }

      // Event log (undecorated)
      const ww = Math.max((process.stdout.columns ?? 80) || 80, 60);
      const eventRows: string[] = [chalk.gray("  \u2500\u2500\u2500 Events " + "\u2500".repeat(Math.min(ww - 16, 90)))];
      // All-done indicator: visible immediately when swarm finishes, before summary / steering
      if (allDone && swarm.phase !== "done") {
        eventRows.push(chalk.dim("  (all tasks done \u2014 processing)"));
        eventRows.push("");
      }
      const logN = Math.min(12, swarm.logs.length);
      for (const entry of swarm.logs.slice(-logN)) {
        const t = new Date(entry.time).toLocaleTimeString("en", { hour12: false });
        const tag = entry.agentId < 0 ? chalk.magenta("[sys]") : chalk.cyan(`[${entry.agentId}]`);
        const arrowIdx = entry.text.indexOf(" \u2192 ");
        if (arrowIdx > 0 && arrowIdx < 20) {
          const toolName = entry.text.slice(0, arrowIdx);
          const target = entry.text.slice(arrowIdx + 3);
          eventRows.push(chalk.gray(`  ${t} `) + tag + ` ${chalk.yellow(toolName)}`);
          eventRows.push(chalk.dim(`      ${truncate(target, ww - 10)}`));
        } else {
          eventRows.push(chalk.gray(`  ${t} `) + tag + ` ${colorEvent(truncate(entry.text, ww - 22))}`);
        }
      }
      secs.push({ title: "", rows: eventRows });

      return secs;
    },
  };

  // Build footer
  let hotkeyRow: string | undefined;
  const extraFooterRows: string[] = [];
  // Collapsed panel bar shown in footer area
  if (panel?.visible && !panel.state.expanded) {
    const bar = panel.renderCollapsed(Math.max((process.stdout.columns ?? 80) || 80, 60));
    if (bar) extraFooterRows.push(bar);
  }
  if (showHotkeys) {
    const pending = runInfo?.pendingSteer ?? 0;
    const chip = pending > 0 ? chalk.cyan(`  \u270E ${pending} steer queued`) : "";
    const fixChip = swarm.failed > 0 && swarm.active > 0 ? chalk.yellow("  [f] fix") : "";
    const retryChip = swarm.rateLimitPaused > 0 ? chalk.yellow("  [r] retry-now") : "";
    const pauseLabel = swarm.paused ? "[p] resume" : "[p] pause";
    const detailChip = swarm.active > 0 ? chalk.dim("  [d] detail") : "";
    const selectChip = swarm.active > 0 && running.length <= 10 ? chalk.dim("  [0-9] select") : "";
    const panelChip = panel?.visible ? chalk.green(`  [Ctrl-O] ${panel.state.expanded ? "collapse" : "expand"}`) : "";
    hotkeyRow = chalk.dim(`  [b] budget  [t] cap  [c] conc  [e] extra  ${pauseLabel}  [s] steer  [?] ask  [q] stop`) + fixChip + retryChip + chip + detailChip + selectChip + panelChip;
    if (swarm.blocked > 0 && swarm.blocked === swarm.active) {
      extraFooterRows.push(chalk.yellow(`  all workers rate-limited  -- [r] retry-now, [c] reduce concurrency, [p] pause, [q] quit`));
    }
  }

  return renderUnifiedFrame({
    model: runInfo?.model ?? swarm.model,
    phase,
    barPct: swarm.total > 0 ? swarm.completed / swarm.total : 0,
    barLabel: `${swarm.completed}/${swarm.total}`,
    active: swarm.active,
    blocked: swarm.blocked,
    queued: swarm.pending,
    startedAt: runInfo?.startedAt ?? swarm.startedAt,
    totalIn: (runInfo?.accIn ?? 0) + swarm.totalInputTokens,
    totalOut: (runInfo?.accOut ?? 0) + swarm.totalOutputTokens,
    totalCost: (runInfo?.accCost ?? swarm.baseCostUsd) + swarm.totalCostUsd,
    waveNum: runInfo?.waveNum ?? -1,
    sessionsUsed: (runInfo ? runInfo.accCompleted + runInfo.accFailed : 0) + waveUsed,
    sessionsBudget: runInfo?.sessionsBudget ?? swarm.total,
    remaining: Math.max(0, (runInfo?.remaining ?? swarm.total) - waveUsed),
    usageBarRender: (out, w) => renderUsageBars(out, w, swarm, selectedAgentId),
    content,
    hotkeyRow,
    extraFooterRows,
    maxRows,
  });
}

export interface SteeringViewData {
  /** The ephemeral ticker heartbeat  -- elapsed, tool count, cost, current reasoning snippet. */
  statusLine: string;
  /** Persistent scrollback of discrete events (tool uses, retries, nudges). */
  events: SteeringEvent[];
  /** Optional context read from disk at setSteering() time. */
  context?: SteeringContext;
}

function section(out: string[], w: number, title: string): void {
  const inner = ` ${title} `;
  const dashW = Math.max(3, Math.min(w - 6, 96) - inner.length);
  out.push(chalk.gray("  \u2500\u2500\u2500" + inner + "\u2500".repeat(dashW)));
}

function renderSteeringUsageBar(out: string[], w: number, rl: ReturnType<RLGetter>): void {
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
      const waitSec = Math.ceil((rl.resetsAt - Date.now()) / 1000);
      const mm = Math.floor(waitSec / 60), ss = waitSec % 60;
      lbl = chalk.red(`Waiting for reset ${mm > 0 ? `${mm}m ${ss}s` : `${ss}s`}`);
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
    const label = `${fmtTokens(tok)}/${fmtTokens(safe)} safe  ${chalk.dim(`planner · ${modelDisplayName(rl.model)}`)}`;
    drawContextBar(out, w, tok, safe, label);
  }
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
  for (const ln of lines) out.push(`  ${chalk.dim(truncate(ln.trim(), w - 4))}`);
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

      // Expanded panel (debrief, ask, custom) — rendered as first section
      if (panel?.visible && panel.state.expanded) {
        const panelRows = maxRows != null ? Math.max(4, maxRows - 6) : 12;
        const lines = panel.renderExpanded(ww, panelRows);
        if (lines.length > 0) secs.push({ title: "", rows: lines });
      }

      // Objective (undecorated  -- raw line)
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
      if (events.length === 0) {
        plannerRows.push(chalk.dim("  (waiting for planner\u2026)"));
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
      secs.push({ title: "Planner activity", rows: plannerRows });

      // Status line (undecorated)
      const liveClean = data.statusLine.replace(/\n/g, " ");
      secs.push({ title: "", rows: [`  ${chalk.cyan("\u25B6")} ${chalk.dim(truncate(liveClean, ww - 6))}`] });

      return secs;
    },
  };

  // Usage bar
  const usageBarRender = rlGetter
    ? (out: string[], w: number) => {
        const rl = rlGetter();
        if (rl && (rl.utilization > 0 || rl.windows.size > 0 || (rl.contextTokens ?? 0) > 0)) {
          renderSteeringUsageBar(out, w, rl);
        }
      }
    : undefined;

  // Footer
  let hotkeyRow: string | undefined;
  const extraFooterRows: string[] = [];
  // Collapsed panel bar shown in footer area
  if (panel?.visible && !panel.state.expanded) {
    const bar = panel.renderCollapsed(Math.max((process.stdout.columns ?? 80) || 80, 60));
    if (bar) extraFooterRows.push(bar);
  }
  if (showHotkeys) {
    const pending = runInfo?.pendingSteer ?? 0;
    const chip = pending > 0 ? chalk.cyan(`  \u270E ${pending} steer queued`) : "";
    const panelChip = panel?.visible ? chalk.green(`  [Ctrl-O] ${panel.state.expanded ? "collapse" : "expand"}`) : "";
    hotkeyRow = chalk.dim("  [b] budget  [s] steer  [q] stop") + chip + panelChip;
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

export function renderSummary(swarm: Swarm): string {
  const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
  const out: string[] = [];

  const ctxW = 5;
  const fixedW = 3 + 6 + 8 + 5 + 5 + 8 + ctxW + 14;
  const taskW = Math.max(10, w - fixedW);

  out.push("");
  out.push(chalk.gray(
    "  " + "#".padStart(3) + "  " + "Status".padEnd(6) + "  " + "Task".padEnd(taskW) +
    "  " + "Duration".padStart(8) + "  " + "Files".padStart(5) + "  " + "Tools".padStart(5) + "  " + "Ctx%".padStart(ctxW) + "  " + "Cost".padStart(8),
  ));
  out.push(chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, fixedW + taskW))));

  const groups: AgentState[][] = [
    swarm.agents.filter(a => a.status === "running"),
    swarm.agents.filter(a => a.status === "paused"),
    swarm.agents.filter(a => a.status === "done"),
    swarm.agents.filter(a => a.status === "error"),
  ].filter(g => g.length > 0);

  const thinSep = chalk.gray("  " + "\u254C".repeat(Math.min(w - 4, fixedW + taskW)));
  let totalDurMs = 0, totalFiles = 0, totalTools = 0, totalCost = 0;
  let peakCtxPct = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) out.push(thinSep);
    for (const a of groups[gi]) {
      const id = String(a.id).padStart(3);
      const ok = a.status === "done";
      const status = ok ? chalk.green("\u2713 done")
        : a.status === "running" ? chalk.blue("~ run ")
        : a.status === "paused" ? chalk.yellow("\u23F8 paused")
        : chalk.red("\u2717 err ");
      const task = truncate(a.task.prompt, taskW).padEnd(taskW);
      const durMs = a.startedAt != null ? (a.finishedAt ?? Date.now()) - a.startedAt : 0;
      const dur = fmtDur(durMs).padStart(8);
      const files = String(a.filesChanged ?? 0).padStart(5);
      const tools = String(a.toolCalls).padStart(5);
      const cost = a.costUsd != null ? `$${a.costUsd.toFixed(3)}`.padStart(8) : "".padStart(8);
      const mdl = a.task.model || swarm.model || "unknown";
      const safe = getModelCapability(mdl).safeContext;
      const ctxTok = a.contextTokens ?? 0;
      const { pct: ctxPct, color: ctxColor } = ctxTok > 0 ? contextFillInfo(ctxTok, safe) : { pct: 0, color: chalk.gray };
      if (ctxPct > peakCtxPct) peakCtxPct = ctxPct;
      const ctxCell = ctxTok > 0 ? `${ctxPct}%`.padStart(ctxW) : "".padStart(ctxW);
      totalDurMs += durMs; totalFiles += a.filesChanged ?? 0; totalTools += a.toolCalls; totalCost += a.costUsd ?? 0;
      const color = ok ? chalk.white : a.status === "running" ? chalk.blue : a.status === "paused" ? chalk.yellow : chalk.red;
      out.push(color(`  ${id}  ${status}  ${task}  ${dur}  ${files}  ${tools}  `) + (ctxTok > 0 ? ctxColor(ctxCell) : chalk.gray(ctxCell)) + color(`  ${cost}`));
    }
  }

  out.push(chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, fixedW + taskW))));
  const label = `${swarm.agents.length} tasks`.padEnd(taskW);
  const peakCell = peakCtxPct > 0 ? `${peakCtxPct}%`.padStart(ctxW) : "".padStart(ctxW);
  out.push(chalk.bold(
    `  ${"".padStart(3)}  ${"Total ".padEnd(6)}  ${label}  ${fmtDur(totalDurMs).padStart(8)}  ${String(totalFiles).padStart(5)}  ${String(totalTools).padStart(5)}  ${peakCell}  ${`$${totalCost.toFixed(3)}`.padStart(8)}`,
  ));
  out.push("");
  return out.join("\n");
}

// ── Row formatting ──

function fmtRow(a: AgentState, w: number, selected = false): string {
  const id = selected ? chalk.cyan.bold(String(a.id).padStart(3)) : String(a.id).padStart(3);
  const elapsed = a.status === "running" && a.startedAt ? " " + chalk.dim(fmtDur(Date.now() - a.startedAt)) : "";
  const spin = SPINNER[Math.floor(Date.now() / 250) % SPINNER.length];
  const icon = a.status === "running"
    ? (a.blockedAt ? chalk.yellow("\u25CF blk") : chalk.blue(`${spin} run`)) + elapsed
    : a.status === "paused" ? chalk.yellow("\u23F8 paused")
    : a.status === "done" ? chalk.green("\u2713 done") : chalk.red("\u2717 err ");
  const taskW = Math.max(20, Math.min(36, w - 50));
  const task = truncate(a.task.prompt, taskW).padEnd(taskW);

  let action: string;
  if (a.blockedAt) {
    action = chalk.yellow(`rate-limited ${fmtDur(Date.now() - a.blockedAt)}`);
  } else if (a.currentTool) {
    action = chalk.yellow(a.currentTool);
  } else if (a.status === "running") {
    action = chalk.dim(truncate(a.lastText || "...", 24));
  } else if (a.status === "paused") {
    const dur = fmtDur((Date.now()) - (a.startedAt || Date.now()));
    action = chalk.yellow(`paused ${dur}`);
  } else if (a.status === "done") {
    const dur = fmtDur((a.finishedAt || Date.now()) - (a.startedAt || Date.now()));
    const cost = a.costUsd != null ? ` $${a.costUsd.toFixed(3)}` : "";
    const files = a.filesChanged != null && a.filesChanged > 0 ? chalk.dim(` ${a.filesChanged}f`) : "";
    action = chalk.dim(`${dur}${cost}${files}`);
  } else {
    action = chalk.red(truncate(a.error || "error", 24));
  }
  return `  ${id}  ${icon}  ${task}  ${action}`;
}
