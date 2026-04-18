import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Text, Box } from "ink";
import chalk from "chalk";
import { deriveFooter } from "./footer-state.js";
import { visibleLen } from "./primitives.js";
function renderAction(a) {
    const keyTag = `[${a.key}]`;
    if (a.state === "enabled")
        return chalk.white(`${keyTag} ${a.label}`);
    // disabled:context or disabled:notready — same dim render; the reason is
    // surfaced only via the toast when pressed.
    return chalk.dim(`${keyTag} ${a.label}`);
}
function terminalWidth() { return Math.max((process.stdout.columns ?? 80) || 80, 60); }
/** Join rendered actions into one line, or two evenly-split lines if a single
 *  line would overflow the terminal. Keeps the canonical slot order. */
function layoutActions(rendered, pendingChip, termW) {
    const joined = rendered.join("  ") + pendingChip;
    const budget = termW - 4; // match the leading "  " indent
    if (visibleLen(joined) <= budget)
        return ["  " + joined];
    const mid = Math.ceil(rendered.length / 2);
    return [
        "  " + rendered.slice(0, mid).join("  "),
        "  " + rendered.slice(mid).join("  ") + pendingChip,
    ];
}
export function Footer({ state, toast }) {
    const inOverlay = state.input.mode;
    if (inOverlay !== "none") {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: " " }), _jsx(Text, { children: chalk.dim("  Enter submit \u00b7 Esc cancel") })] }));
    }
    const actions = deriveFooter(state);
    const pending = state.runInfo.pendingSteer ?? 0;
    const pendingChip = pending > 0 ? chalk.cyan(`  \u270E ${pending} steer queued`) : "";
    const lines = layoutActions(actions.map(renderAction), pendingChip, terminalWidth());
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: " " }), lines.map((ln, i) => _jsx(Text, { children: ln }, i)), toast ? _jsx(Text, { children: chalk.yellow("  \u26A0 " + toast) }) : null] }));
}
/** Used only for tests / introspection. */
export function __deriveFooterForRunInfo(_runInfo) { }
