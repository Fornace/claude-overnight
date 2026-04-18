// The unified frame layout — a fixed header, an elastic content area, and a
// fixed footer. Both the run-phase frame and the steering frame go through
// this same pipeline so sizing, phase labels, and session counters behave
// identically across phases.
import chalk from "chalk";
import { fmtDur, fmtTokens, section } from "./primitives.js";
// ── Header ──
function renderHeader(out, w, p) {
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
    out.push(`  ${chalk.bold.white("CLAUDE OVERNIGHT")}${modelTag}${phaseTag}  ${bar}  ` +
        `${p.barLabel}  ` +
        (activeChip ? activeChip + "  " : "") +
        (p.queued > 0 ? chalk.gray(`${p.queued} queued`) + "  " : "") +
        chalk.gray(`\u23F1 ${fmtDur(Date.now() - p.startedAt)}`));
    const tokIn = fmtTokens(p.totalIn);
    const tokOut = fmtTokens(p.totalOut);
    const costStr = p.totalCost > 0 ? chalk.yellow(`$${p.totalCost.toFixed(2)}`) : "";
    const waveLabel = p.waveNum >= 0 ? `wave ${p.waveNum + 1} \u00b7 ` : "";
    const sessionStr = chalk.dim(`  ${waveLabel}`) +
        chalk.white(`${p.sessionsUsed}/${p.sessionsBudget}`) +
        chalk.dim(` sessions \u00b7 ${p.remaining} left`);
    out.push(chalk.gray(`  \u2191 ${tokIn} in  \u2193 ${tokOut} out`) +
        (costStr ? `  ${costStr}` : "") + sessionStr);
}
// ── Unified frame renderer ──
//
// The content area is the only elastic region. When `maxRows` is set we draw
// header and footer in full, then stop filling content as soon as the budget
// is reached. This keeps the budget-bar and hotkey row visible even at very
// small terminal sizes.
export function renderUnifiedFrame(params) {
    const w = Math.max((process.stdout.columns ?? 80) || 80, 60);
    // ── Header (fixed) ──
    const header = [];
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
    if (params.usageBarRender)
        params.usageBarRender(header, w);
    header.push("");
    // ── Footer (fixed) ──
    const footer = [""];
    if (params.hotkeyRow)
        footer.push(params.hotkeyRow);
    if (params.extraFooterRows)
        for (const row of params.extraFooterRows)
            footer.push(row);
    footer.push("");
    // ── Content (elastic — shrinks to fit) ──
    const contentBudget = params.maxRows != null
        ? Math.max(0, params.maxRows - header.length - footer.length)
        : Infinity;
    const content = [];
    const sections = params.content.sections();
    for (const sec of sections) {
        if (content.length >= contentBudget)
            break;
        if (sec.title)
            section(content, w, sec.title);
        for (const row of sec.rows) {
            if (content.length >= contentBudget)
                break;
            content.push(row);
        }
    }
    const full = [...header, ...content, ...footer];
    if (params.maxRows != null && full.length > params.maxRows) {
        return full.slice(0, Math.max(0, params.maxRows)).join("\n");
    }
    return full.join("\n");
}
