// The fixed footer — action bar + overlay hint.
//
// Never branches on phase — phases supply capability flags via the store and
// `deriveFooter` maps them to the canonical 8-slot Action list. Dim keys keep
// their slot and surface a toast when pressed (toast state is transient; see
// input.tsx).

import React from "react";
import { Text, Box } from "ink";
import chalk from "chalk";
import { deriveFooter } from "./footer-state.js";
import type { Action } from "./footer-state.js";
import type { InputMode, UiState } from "./store.js";
import type { RunInfo } from "./types.js";
import { terminalWidth, visibleLen } from "./primitives.js";

function renderAction(a: Action): string {
  const keyTag = `[${a.key}]`;
  if (a.state === "enabled") return chalk.white(`${keyTag} ${a.label}`);
  // disabled:context or disabled:notready — same dim render; the reason is
  // surfaced only via the toast when pressed.
  return chalk.dim(`${keyTag} ${a.label}`);
}

/** Join rendered actions into one line, or two evenly-split lines if a single
 *  line would overflow the terminal. Keeps the canonical slot order. */
function layoutActions(rendered: string[], pendingChip: string, termW: number): string[] {
  const joined = rendered.join("  ") + pendingChip;
  const budget = termW - 4; // match the leading "  " indent
  if (visibleLen(joined) <= budget) return ["  " + joined];
  const mid = Math.ceil(rendered.length / 2);
  return [
    "  " + rendered.slice(0, mid).join("  "),
    "  " + rendered.slice(mid).join("  ") + pendingChip,
  ];
}

interface Props {
  state: UiState;
  toast?: string;
}

export function Footer({ state, toast }: Props): React.ReactElement {
  const inOverlay: InputMode = state.input.mode;

  // When an input overlay is active the InputPrompt box renders its own hint
  // line, so the footer stays quiet — just a spacer to keep the layout stable.
  if (inOverlay !== "none") {
    return <Text> </Text>;
  }

  const actions = deriveFooter(state);
  const pending = state.runInfo.pendingSteer ?? 0;
  const pendingChip = pending > 0 ? chalk.cyan(`  \u270E ${pending} steer queued`) : "";
  const lines = layoutActions(actions.map(renderAction), pendingChip, terminalWidth());

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {lines.map((ln, i) => <Text key={i}>{ln}</Text>)}
      {toast ? <Text>{chalk.yellow("  \u26A0 " + toast)}</Text> : null}
    </Box>
  );
}

/** Used only for tests / introspection. */
export function __deriveFooterForRunInfo(_runInfo: RunInfo): void { /* no-op */ }
