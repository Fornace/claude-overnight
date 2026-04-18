// Run-phase frame + summary table.
//
// This file is the public face of the renderer module: it owns the
// "active swarm" frame and the post-run summary, and re-exports the rest of
// the API so external callers see a single entry point.
import chalk from "chalk";
import { getModelCapability, modelDisplayName } from "../../core/models.js";
import { colorEvent, fmtDur, fmtTokens, renderWaitingIndicator, spinnerFrame, truncate, } from "./primitives.js";
import { renderUnifiedFrame } from "./layout.js";
import { contextFillInfo, renderUsageBars } from "./bars.js";
// ── Public re-exports ──
//
// Keep the import path `./render.js` stable for every external caller. New
// internal modules are an implementation detail of this folder.
export { fmtDur, fmtTokens, renderWaitingIndicator, spinnerFrame, truncate, wrap, } from "./primitives.js";
export { renderUnifiedFrame } from "./layout.js";
export { contextFillInfo } from "./bars.js";
export { renderSteeringFrame } from "./steering.js";
// ── Run-phase frame ──
export function renderFrame(swarm, showHotkeys, runInfo, selectedAgentId, maxRows, panel) {
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
    const content = {
        sections() {
            const secs = [];
            const ww = Math.max((process.stdout.columns ?? 80) || 80, 60);
            // Agent table (undecorated — raw header + rows)
            if (show.length > 0) {
                const rows = [
                    chalk.gray("  #   Model              Status   Task" + " ".repeat(Math.max(1, ww) - 68)) + "Action",
                    chalk.gray("  " + "\u2500".repeat(Math.min(ww - 4, 100))),
                ];
                for (const a of show)
                    rows.push(fmtRow(a, ww, a.id === (selectedAgentId ?? -1)));
                if (swarm.pending > 0)
                    rows.push(chalk.gray(`  ... + ${swarm.pending} queued`));
                secs.push({ title: "", rows });
            }
            // Agent detail (decorated)
            if (detailAgent) {
                const rows = [];
                const taskLines = detailAgent.task.prompt.split("\n");
                const maxTaskLines = Math.min(6, taskLines.length);
                for (let i = 0; i < maxTaskLines; i++) {
                    rows.push(`  ${chalk.dim(truncate(taskLines[i].trim(), ww - 6))}`);
                }
                if (taskLines.length > maxTaskLines)
                    rows.push(chalk.dim(`  \u2026 + ${taskLines.length - maxTaskLines} more lines`));
                const meta = [];
                if (detailAgent.currentTool)
                    meta.push(chalk.yellow(`tool: ${detailAgent.currentTool}`));
                if (detailAgent.lastText)
                    meta.push(chalk.dim(truncate(detailAgent.lastText, 60)));
                if (detailAgent.filesChanged != null)
                    meta.push(chalk.dim(`${detailAgent.filesChanged} files`));
                if (detailAgent.costUsd != null)
                    meta.push(chalk.yellow(`$${detailAgent.costUsd.toFixed(3)}`));
                if (detailAgent.toolCalls > 0)
                    meta.push(chalk.dim(`${detailAgent.toolCalls} tools`));
                if ((detailAgent.peakContextTokens ?? detailAgent.contextTokens ?? 0) > 0) {
                    const mdl = detailAgent.task.model || swarm.model || "unknown";
                    const safe = getModelCapability(mdl).safeContext;
                    const tok = detailAgent.peakContextTokens ?? detailAgent.contextTokens ?? 0;
                    const { pct, color } = contextFillInfo(tok, safe);
                    meta.push(color(`ctx ${fmtTokens(tok)}/${fmtTokens(safe)} (${pct}%)`));
                }
                if (meta.length > 0)
                    rows.push(`  ${meta.join(chalk.dim("  \u00b7 "))}`);
                secs.push({ title: `Agent ${detailAgent.id} detail \u00b7 [d] next \u00b7 [Esc] close`, rows });
            }
            // Merge results (undecorated)
            if (swarm.mergeResults.length > 0) {
                const rows = [chalk.gray("  \u2500\u2500\u2500 Merges " + "\u2500".repeat(Math.min(ww - 16, 90)))];
                for (const mr of swarm.mergeResults) {
                    const icon = mr.ok ? chalk.green("\u2713") : chalk.red("\u2717");
                    const info = mr.ok ? chalk.dim(`${mr.filesChanged} file(s)`) : chalk.red(truncate(mr.error || "conflict", 40));
                    rows.push(`  ${icon} ${mr.branch}  ${info}`);
                }
                secs.push({ title: "", rows });
            }
            // Event log (undecorated)
            const eventRows = [chalk.gray("  \u2500\u2500\u2500 Events " + "\u2500".repeat(Math.min(ww - 16, 90)))];
            // All-done indicator: visible immediately when swarm finishes, before summary / steering
            if (allDone && swarm.phase !== "done") {
                const phaseLabel = swarm.phase === "merging" ? "Merging branches" : "Finalizing wave";
                eventRows.push("  " + renderWaitingIndicator(phaseLabel, swarm.startedAt, { style: "thinking" }));
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
                }
                else {
                    eventRows.push(chalk.gray(`  ${t} `) + tag + ` ${colorEvent(truncate(entry.text, ww - 22))}`);
                }
            }
            secs.push({ title: "", rows: eventRows });
            return secs;
        },
    };
    // Build footer
    let hotkeyRow;
    const extraFooterRows = [];
    if (showHotkeys) {
        const pending = runInfo?.pendingSteer ?? 0;
        const chip = pending > 0 ? chalk.cyan(`  \u270E ${pending} steer queued`) : "";
        const fixChip = swarm.failed > 0 && swarm.active > 0 ? chalk.yellow("  [f] fix") : "";
        const retryChip = swarm.rateLimitPaused > 0 ? chalk.yellow("  [r] retry-now") : "";
        const pauseLabel = swarm.paused ? "[p] resume" : "[p] pause";
        const detailChip = swarm.active > 0 ? chalk.dim("  [d] detail") : "";
        const selectChip = swarm.active > 0 && running.length <= 10 ? chalk.dim("  [0-9] select") : "";
        const panelChip = panel?.visible ? chalk.green(`  [Ctrl-O] ${panel.state.expanded ? "collapse" : "expand"}`) : "";
        hotkeyRow = chalk.dim(`  [s] settings  ${pauseLabel}  [i] inject  [?] ask  [q] stop`) + fixChip + retryChip + chip + detailChip + selectChip + panelChip;
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
// ── Per-row formatting for the agent table ──
function fmtRow(a, w, selected = false) {
    const id = selected ? chalk.cyan.bold(String(a.id).padStart(3)) : String(a.id).padStart(3);
    const mdl = modelDisplayName(a.model || a.task.model || "unknown");
    const modelW = 18;
    const modelStr = truncate(mdl, modelW).padEnd(modelW);
    const elapsed = a.status === "running" && a.startedAt ? " " + chalk.dim(fmtDur(Date.now() - a.startedAt)) : "";
    const dot = spinnerFrame("dots");
    const icon = a.status === "running"
        ? (a.blockedAt ? chalk.yellow(`${dot} blk`) : chalk.blue(`${dot} run`)) + elapsed
        : a.status === "paused" ? chalk.yellow("\u23F8 paused")
            : a.status === "done" ? chalk.green("\u2713 done") : chalk.red("\u2717 err ");
    const taskW = Math.max(20, Math.min(36, w - 50 - modelW - 6));
    const task = truncate(a.task.prompt, taskW).padEnd(taskW);
    let action;
    if (a.blockedAt) {
        action = chalk.yellow(`rate-limited ${fmtDur(Date.now() - a.blockedAt)}`);
    }
    else if (a.currentTool) {
        action = chalk.yellow(a.currentTool);
    }
    else if (a.status === "running") {
        action = chalk.dim(truncate(a.lastText || "...", 24));
    }
    else if (a.status === "paused") {
        const dur = fmtDur((Date.now()) - (a.startedAt || Date.now()));
        action = chalk.yellow(`paused ${dur}`);
    }
    else if (a.status === "done") {
        const dur = fmtDur((a.finishedAt || Date.now()) - (a.startedAt || Date.now()));
        const cost = a.costUsd != null ? ` $${a.costUsd.toFixed(3)}` : "";
        const files = a.filesChanged != null && a.filesChanged > 0 ? chalk.dim(` ${a.filesChanged}f`) : "";
        action = chalk.dim(`${dur}${cost}${files}`);
    }
    else {
        action = chalk.red(truncate(a.error || "error", 24));
    }
    return `  ${id}  ${modelStr}  ${icon}  ${task}  ${action}`;
}
// ── Post-run summary table ──
export function renderSummary(swarm) {
    const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
    const out = [];
    const ctxW = 5;
    const modelW = 16;
    const fixedW = 3 + 6 + modelW + 8 + 5 + 5 + 8 + ctxW + 14;
    const taskW = Math.max(10, w - fixedW);
    out.push("");
    out.push(chalk.gray("  " + "#".padStart(3) + "  " + "Status".padEnd(6) + "  " + "Model".padEnd(modelW) + "  " + "Task".padEnd(taskW) +
        "  " + "Duration".padStart(8) + "  " + "Files".padStart(5) + "  " + "Tools".padStart(5) + "  " + "Ctx%".padStart(ctxW) + "  " + "Cost".padStart(8)));
    out.push(chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, fixedW + taskW))));
    const groups = [
        swarm.agents.filter(a => a.status === "running"),
        swarm.agents.filter(a => a.status === "paused"),
        swarm.agents.filter(a => a.status === "done"),
        swarm.agents.filter(a => a.status === "error"),
    ].filter(g => g.length > 0);
    const thinSep = chalk.gray("  " + "\u254C".repeat(Math.min(w - 4, fixedW + taskW)));
    let totalDurMs = 0, totalFiles = 0, totalTools = 0, totalCost = 0;
    let peakCtxPct = 0;
    for (let gi = 0; gi < groups.length; gi++) {
        if (gi > 0)
            out.push(thinSep);
        for (const a of groups[gi]) {
            const id = String(a.id).padStart(3);
            const ok = a.status === "done";
            const status = ok ? chalk.green("\u2713 done")
                : a.status === "running" ? chalk.blue("~ run ")
                    : a.status === "paused" ? chalk.yellow("\u23F8 paused")
                        : chalk.red("\u2717 err ");
            const mdl = a.model || a.task.model || swarm.model || "unknown";
            const modelStr = chalk.dim(truncate(modelDisplayName(mdl), modelW)).padEnd(modelW);
            const task = truncate(a.task.prompt, taskW).padEnd(taskW);
            const durMs = a.startedAt != null ? (a.finishedAt ?? Date.now()) - a.startedAt : 0;
            const dur = fmtDur(durMs).padStart(8);
            const files = String(a.filesChanged ?? 0).padStart(5);
            const tools = String(a.toolCalls).padStart(5);
            const cost = a.costUsd != null ? `$${a.costUsd.toFixed(3)}`.padStart(8) : "".padStart(8);
            const safe = getModelCapability(mdl).safeContext;
            const ctxTok = a.peakContextTokens ?? a.contextTokens ?? 0;
            const { pct: ctxPct, color: ctxColor } = ctxTok > 0 ? contextFillInfo(ctxTok, safe) : { pct: 0, color: chalk.gray };
            if (ctxPct > peakCtxPct)
                peakCtxPct = ctxPct;
            const ctxCell = ctxTok > 0 ? `${ctxPct}%`.padStart(ctxW) : "".padStart(ctxW);
            totalDurMs += durMs;
            totalFiles += a.filesChanged ?? 0;
            totalTools += a.toolCalls;
            totalCost += a.costUsd ?? 0;
            const color = ok ? chalk.white : a.status === "running" ? chalk.blue : a.status === "paused" ? chalk.yellow : chalk.red;
            out.push(color(`  ${id}  ${status}  `) + modelStr + color(`  ${task}  ${dur}  ${files}  ${tools}  `) + (ctxTok > 0 ? ctxColor(ctxCell) : chalk.gray(ctxCell)) + color(`  ${cost}`));
        }
    }
    out.push(chalk.gray("  " + "\u2500".repeat(Math.min(w - 4, fixedW + taskW))));
    const label = `${swarm.agents.length} tasks`.padEnd(taskW);
    const peakCell = peakCtxPct > 0 ? `${peakCtxPct}%`.padStart(ctxW) : "".padStart(ctxW);
    out.push(chalk.bold(`  ${"".padStart(3)}  ${"Total ".padEnd(6)}  ${label}  ${fmtDur(totalDurMs).padStart(8)}  ${String(totalFiles).padStart(5)}  ${String(totalTools).padStart(5)}  ${peakCell}  ${`$${totalCost.toFixed(3)}`.padStart(8)}`));
    if (swarm.staleRecovered > 0 || swarm.staleForceDeleted > 0) {
        out.push(chalk.dim(`  [prior-wave] ${swarm.staleRecovered} recovered + ${swarm.staleForceDeleted} discarded orphan branch(es)`));
    }
    out.push("");
    return out.join("\n");
}
