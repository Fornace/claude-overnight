// Post-run summary table.
//
// Printed after the Ink tree unmounts, so this stays a plain chalk string.
// Keep this separate from the live components — the summary runs once at the
// end and has very different layout (fixed columns, group totals, stable
// output for log capture).
import chalk from "chalk";
import { getModelCapability, modelDisplayName } from "../core/models.js";
import { contextFillInfo, fmtDur, truncate } from "./primitives.js";
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
