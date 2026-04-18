// Ask / debrief overlay — one box above the footer, inside the body slot.
// Non-phases (steer input, ask input, settings input) are handled by input.tsx.

import React from "react";
import { Text, Box } from "ink";
import chalk from "chalk";
import type { AskState } from "./types.js";
import { wrap } from "./primitives.js";

interface Props {
  ask?: AskState;
  debrief?: { text: string; label?: string };
}

function terminalWidth(): number { return Math.max((process.stdout.columns ?? 80) || 80, 60); }

const ASK_BODY_LINES = 8;
const DEBRIEF_BODY_LINES = 6;

export function Overlay({ ask, debrief }: Props): React.ReactElement | null {
  if (!ask && !debrief) return null;
  const w = terminalWidth();
  const boxW = Math.min(Math.max(44, w - 6), 120);
  const innerW = boxW - 4;

  if (ask) {
    const title = ask.streaming ? chalk.cyan("Ask") + chalk.dim(" (streaming\u2026)")
      : ask.error ? chalk.red("Ask") + chalk.dim(" (error)")
      : chalk.bold.white("Ask");
    const qLines = wrap(ask.question, innerW - 4);
    const bodyLines: string[] = [];
    let hiddenExtra = 0;
    if (ask.error) {
      for (const wl of wrap(`Error: ${ask.error}`, innerW - 2)) bodyLines.push(chalk.red(wl));
    } else if (ask.answer) {
      const rawLines = ask.answer.split("\n");
      const visible = rawLines.slice(0, ASK_BODY_LINES);
      hiddenExtra = Math.max(0, rawLines.length - visible.length);
      for (const ln of visible) {
        for (const wl of wrap(ln, innerW - 2)) bodyLines.push(wl);
      }
    } else if (ask.streaming) {
      bodyLines.push(chalk.dim("\u2026"));
    }
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2} borderStyle="round" borderColor="cyan" width={boxW}>
        <Text> {title}</Text>
        {qLines.map((ql, i) => (
          <Text key={`q${i}`}> {i === 0 ? chalk.dim("Q:") + " " : "   "}{ql}</Text>
        ))}
        {bodyLines.map((l, i) => <Text key={i}> {l}</Text>)}
        {hiddenExtra > 0 ? <Text> {chalk.dim(`\u2026 + ${hiddenExtra} more line${hiddenExtra === 1 ? "" : "s"} \u00b7 press Enter to open`)}</Text> : null}
      </Box>
    );
  }

  if (debrief) {
    const title = debrief.label
      ? `${chalk.bold.white("Debrief")} ${chalk.dim("\u00b7")} ${chalk.white(debrief.label)}`
      : chalk.bold.white("Debrief");
    const lines: string[] = [];
    const rawLines = debrief.text.split("\n");
    const visible = rawLines.slice(0, DEBRIEF_BODY_LINES);
    const hiddenExtra = Math.max(0, rawLines.length - visible.length);
    for (const ln of visible) {
      for (const wl of wrap(ln, innerW - 2)) lines.push(wl);
    }
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2} borderStyle="round" borderColor="green" width={boxW}>
        <Text> {title}</Text>
        {lines.map((l, i) => <Text key={i}> {l}</Text>)}
        {hiddenExtra > 0 ? <Text> {chalk.dim(`\u2026 + ${hiddenExtra} more line${hiddenExtra === 1 ? "" : "s"}`)}</Text> : null}
      </Box>
    );
  }

  return null;
}
