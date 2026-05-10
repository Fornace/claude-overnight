import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Text, Box } from "ink";
import chalk from "chalk";
import { fmtDur, fmtTokens, terminalWidth, visibleLen } from "./primitives.js";
import { UsageBars, SteeringBars } from "./bars.js";
// Scales with terminal width so narrow panes get a short bar and wide ones
// don't waste the right half of the screen.
function headerBarWidth(termW) {
    if (termW < 90)
        return 16;
    if (termW < 120)
        return 24;
    return 30;
}
function runPhaseLabel(swarm) {
    const allDone = swarm.agents.length > 0 && swarm.agents.every(a => a.status !== "running");
    const doneTag = allDone && !swarm.aborted ? chalk.green("COMPLETE") : "";
    const stoppingTag = swarm.aborted ? chalk.yellow("STOPPING") : "";
    const pausedTag = swarm.paused ? chalk.yellow("PAUSED") : "";
    const stallTag = swarm.stallLevel >= 3 ? chalk.red("STALL") : swarm.stallLevel > 0 ? chalk.yellow(`STALL L${swarm.stallLevel}`) : "";
    const phaseLabel = swarm.phase === "planning" ? chalk.magenta("PLANNING")
        : swarm.phase === "merging" ? chalk.yellow("MERGING")
            : swarm.rateLimitPaused > 0 ? chalk.yellow("COOLING") : "";
    return [phaseLabel, doneTag, pausedTag, stallTag, stoppingTag].filter(Boolean).join(" ");
}
export function Header({ phase, runInfo, swarm, rlGetter, selectedAgentId }) {
    const termW = terminalWidth();
    const barW = headerBarWidth(termW);
    const narrow = termW < 90;
    const model = runInfo.model ?? swarm?.model;
    const modelTag = model ? chalk.dim(` [${model}]`) : "";
    let phaseTag = "";
    let barPct = 0;
    let barLabel = "";
    let active = 0, blocked = 0, queued = 0;
    let totalIn = runInfo.accIn, totalOut = runInfo.accOut, totalCost = runInfo.accCost;
    let sessionsUsed = runInfo.accCompleted + runInfo.accFailed;
    if (phase === "run" && swarm) {
        const waveUsed = swarm.completed + swarm.failed;
        phaseTag = runPhaseLabel(swarm);
        barPct = swarm.total > 0 ? swarm.completed / swarm.total : 0;
        barLabel = `${swarm.completed}/${swarm.total}`;
        active = swarm.active;
        blocked = swarm.blocked;
        queued = swarm.pending;
        totalIn = (runInfo.accIn ?? 0) + swarm.totalInputTokens;
        totalOut = (runInfo.accOut ?? 0) + swarm.totalOutputTokens;
        totalCost = (runInfo.accCost ?? swarm.baseCostUsd) + swarm.totalCostUsd;
        sessionsUsed = (runInfo.accCompleted + runInfo.accFailed) + waveUsed;
    }
    else if (phase === "steering") {
        phaseTag = chalk.magenta(`STEERING \u2192 wave ${runInfo.waveNum + 2}`);
        barPct = runInfo.sessionsBudget > 0 ? sessionsUsed / runInfo.sessionsBudget : 0;
        barLabel = `${sessionsUsed}/${runInfo.sessionsBudget}`;
    }
    const filled = Math.round(barPct * barW);
    const bar = chalk.green("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(barW - filled));
    const working = Math.max(0, active - blocked);
    const stuck = blocked > 0 && working === 0;
    const activeChip = active > 0
        ? (stuck ? chalk.yellow(`${active} blocked`) : chalk.cyan(`${working} active`) + (blocked > 0 ? chalk.yellow(` (${blocked} blocked)`) : ""))
        : "";
    const elapsed = chalk.gray(`\u23F1 ${fmtDur(Date.now() - runInfo.startedAt)}`);
    const queuedChip = queued > 0 ? chalk.gray(`${queued} queued`) : "";
    // Top line: brand · phase · bar · counters · elapsed. Narrow terminals drop
    // the brand and model so the live indicators stay on one row.
    const brand = narrow ? "" : chalk.bold.white("CLAUDE OVERNIGHT") + modelTag;
    const progress = barLabel ? bar + "  " + barLabel : bar;
    const topParts = [
        brand,
        phaseTag,
        progress,
        activeChip,
        queuedChip,
        elapsed,
    ].filter(Boolean);
    const topLine = "  " + topParts.join("  ");
    const tokIn = fmtTokens(totalIn);
    const tokOut = fmtTokens(totalOut);
    const costStr = totalCost > 0 ? chalk.yellow(`$${totalCost.toFixed(2)}`) : "";
    const waveLabel = runInfo.waveNum >= 0 ? `wave ${runInfo.waveNum + 1}` : "";
    const tokens = chalk.gray(`\u2191 ${tokIn} in  \u2193 ${tokOut} out`);
    const sessions = chalk.white(`${sessionsUsed}/${runInfo.sessionsBudget}`) +
        chalk.dim(` sessions \u00b7 ${runInfo.remaining} left`);
    const bottomLeftParts = [tokens, costStr].filter(Boolean).join("  ");
    const bottomRightParts = [waveLabel ? chalk.dim(waveLabel) : "", sessions].filter(Boolean).join(chalk.dim(" \u00b7 "));
    const gap = Math.max(2, termW - visibleLen(bottomLeftParts) - visibleLen(bottomRightParts) - 4);
    const bottomLine = "  " + bottomLeftParts + " ".repeat(gap) + bottomRightParts;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: " " }), _jsx(Text, { children: topLine }), _jsx(Text, { children: bottomLine }), phase === "run" && swarm ? _jsx(UsageBars, { swarm: swarm, selectedAgentId: selectedAgentId }) : null, phase === "steering" && rlGetter ? _jsx(SteeringBars, { rl: rlGetter() }) : null, _jsx(Text, { children: " " })] }));
}
