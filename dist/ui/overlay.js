import { jsxs as _jsxs } from "react/jsx-runtime";
import { Text, Box } from "ink";
import chalk from "chalk";
import { wrap } from "./primitives.js";
function terminalWidth() { return Math.max((process.stdout.columns ?? 80) || 80, 60); }
const ASK_BODY_LINES = 8;
const DEBRIEF_BODY_LINES = 6;
export function Overlay({ ask, debrief }) {
    if (!ask && !debrief)
        return null;
    const w = terminalWidth();
    const boxW = Math.min(Math.max(44, w - 6), 120);
    const innerW = boxW - 4;
    if (ask) {
        const title = ask.streaming ? chalk.cyan("Ask") + chalk.dim(" (streaming\u2026)")
            : ask.error ? chalk.red("Ask") + chalk.dim(" (error)")
                : chalk.bold.white("Ask");
        const qLines = wrap(ask.question, innerW - 4);
        const bodyLines = [];
        let hiddenExtra = 0;
        if (ask.error) {
            for (const wl of wrap(`Error: ${ask.error}`, innerW - 2))
                bodyLines.push(chalk.red(wl));
        }
        else if (ask.answer) {
            const rawLines = ask.answer.split("\n");
            const visible = rawLines.slice(0, ASK_BODY_LINES);
            hiddenExtra = Math.max(0, rawLines.length - visible.length);
            for (const ln of visible) {
                for (const wl of wrap(ln, innerW - 2))
                    bodyLines.push(wl);
            }
        }
        else if (ask.streaming) {
            bodyLines.push(chalk.dim("\u2026"));
        }
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2, borderStyle: "round", borderColor: "cyan", width: boxW, children: [_jsxs(Text, { children: [" ", title] }), qLines.map((ql, i) => (_jsxs(Text, { children: [" ", i === 0 ? chalk.dim("Q:") + " " : "   ", ql] }, `q${i}`))), bodyLines.map((l, i) => _jsxs(Text, { children: [" ", l] }, i)), hiddenExtra > 0 ? _jsxs(Text, { children: [" ", chalk.dim(`\u2026 + ${hiddenExtra} more line${hiddenExtra === 1 ? "" : "s"} \u00b7 press Enter to open`)] }) : null] }));
    }
    if (debrief) {
        const title = debrief.label
            ? `${chalk.bold.white("Debrief")} ${chalk.dim("\u00b7")} ${chalk.white(debrief.label)}`
            : chalk.bold.white("Debrief");
        const lines = [];
        const rawLines = debrief.text.split("\n");
        const visible = rawLines.slice(0, DEBRIEF_BODY_LINES);
        const hiddenExtra = Math.max(0, rawLines.length - visible.length);
        for (const ln of visible) {
            for (const wl of wrap(ln, innerW - 2))
                lines.push(wl);
        }
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2, borderStyle: "round", borderColor: "green", width: boxW, children: [_jsxs(Text, { children: [" ", title] }), lines.map((l, i) => _jsxs(Text, { children: [" ", l] }, i)), hiddenExtra > 0 ? _jsxs(Text, { children: [" ", chalk.dim(`\u2026 + ${hiddenExtra} more line${hiddenExtra === 1 ? "" : "s"}`)] }) : null] }));
    }
    return null;
}
