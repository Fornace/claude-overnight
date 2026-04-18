import { jsxs as _jsxs } from "react/jsx-runtime";
import { Text, Box } from "ink";
import chalk from "chalk";
import { wrap } from "./primitives.js";
function terminalWidth() { return Math.max((process.stdout.columns ?? 80) || 80, 60); }
export function Overlay({ ask, debrief }) {
    if (!ask && !debrief)
        return null;
    const w = terminalWidth();
    const maxW = Math.min(Math.max(40, w - 6), 120);
    if (ask) {
        const title = ask.streaming ? chalk.cyan("Ask (streaming\u2026)") : ask.error ? chalk.red("Ask (error)") : chalk.bold.white("Ask");
        const qLines = wrap(ask.question, maxW - 6);
        const bodyLines = [];
        if (ask.error) {
            for (const wl of wrap(`Error: ${ask.error}`, maxW - 4))
                bodyLines.push(chalk.red(wl));
        }
        else if (ask.answer) {
            for (const ln of ask.answer.split("\n").slice(0, 8)) {
                for (const wl of wrap(ln, maxW - 4))
                    bodyLines.push(wl);
            }
        }
        else if (ask.streaming) {
            bodyLines.push(chalk.dim("\u2026"));
        }
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2, borderStyle: "round", borderColor: "cyan", width: maxW, children: [_jsxs(Text, { children: [" ", title] }), qLines.map((ql, i) => (_jsxs(Text, { children: [" ", i === 0 ? chalk.dim("Q:") + " " : "   ", ql] }, `q${i}`))), bodyLines.map((l, i) => _jsxs(Text, { children: [" ", l] }, i))] }));
    }
    if (debrief) {
        const title = debrief.label
            ? `${chalk.bold.white("Debrief")} ${chalk.dim("\u00b7")} ${chalk.white(debrief.label)}`
            : chalk.bold.white("Debrief");
        const lines = [];
        for (const ln of debrief.text.split("\n").slice(0, 6)) {
            for (const wl of wrap(ln, maxW - 4))
                lines.push(wl);
        }
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2, borderStyle: "round", borderColor: "green", width: maxW, children: [_jsxs(Text, { children: [" ", title] }), lines.map((l, i) => _jsxs(Text, { children: [" ", l] }, i))] }));
    }
    return null;
}
