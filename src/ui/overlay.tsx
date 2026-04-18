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

export function Overlay({ ask, debrief }: Props): React.ReactElement | null {
  if (!ask && !debrief) return null;
  const w = terminalWidth();
  const maxW = Math.min(Math.max(40, w - 6), 120);

  if (ask) {
    const title = ask.streaming ? chalk.cyan("Ask (streaming\u2026)") : ask.error ? chalk.red("Ask (error)") : chalk.bold.white("Ask");
    const qLines = wrap(ask.question, maxW - 6);
    const bodyLines: string[] = [];
    if (ask.error) {
      for (const wl of wrap(`Error: ${ask.error}`, maxW - 4)) bodyLines.push(chalk.red(wl));
    } else if (ask.answer) {
      for (const ln of ask.answer.split("\n").slice(0, 8)) {
        for (const wl of wrap(ln, maxW - 4)) bodyLines.push(wl);
      }
    } else if (ask.streaming) {
      bodyLines.push(chalk.dim("\u2026"));
    }
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2} borderStyle="round" borderColor="cyan" width={maxW}>
        <Text> {title}</Text>
        {qLines.map((ql, i) => (
          <Text key={`q${i}`}> {i === 0 ? chalk.dim("Q:") + " " : "   "}{ql}</Text>
        ))}
        {bodyLines.map((l, i) => <Text key={i}> {l}</Text>)}
      </Box>
    );
  }

  if (debrief) {
    const title = debrief.label
      ? `${chalk.bold.white("Debrief")} ${chalk.dim("\u00b7")} ${chalk.white(debrief.label)}`
      : chalk.bold.white("Debrief");
    const lines: string[] = [];
    for (const ln of debrief.text.split("\n").slice(0, 6)) {
      for (const wl of wrap(ln, maxW - 4)) lines.push(wl);
    }
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2} borderStyle="round" borderColor="green" width={maxW}>
        <Text> {title}</Text>
        {lines.map((l, i) => <Text key={i}> {l}</Text>)}
      </Box>
    );
  }

  return null;
}
