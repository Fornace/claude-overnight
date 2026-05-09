// Terminal display helpers: spinner frames, plan listing, dual-mode progress log.

import chalk from "chalk";
import type { Task } from "../core/types.js";
import { terminalWidth } from "../ui/primitives.js";

export const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const termWidth = (margin = 6): number => Math.max(terminalWidth() - margin, 40);

export function showPlan(tasks: Task[]): void {
  const w = termWidth();
  const ruleLen = Math.min(w, 70);
  console.log(chalk.dim(`  ─── ${tasks.length} tasks ${"─".repeat(Math.max(0, ruleLen - String(tasks.length).length - 10))}`));
  for (const t of tasks) {
    const num = chalk.dim(String(Number(t.id) + 1).padStart(4) + ".");
    console.log(`${num} ${t.prompt.slice(0, w)}`);
  }
  console.log(chalk.dim(`  ${"─".repeat(ruleLen)}\n`));
}

/** Numbered list line: `  N. text` with a dim N. Use for themes, plan reviews, etc. */
export function numberedLine(i: number, text: string, padStart = 3): string {
  return `${chalk.dim(`  ${String(i + 1).padStart(padStart)}.`)} ${text}`;
}

/** Dual-mode progress renderer.
 *
 *  - `status` (default): transient single-line ticker — clears itself each frame.
 *    Use for elapsed-time / cost / rolling tail of model text.
 *  - `event`: permanent log line — scrolls up, ticker redraws underneath.
 *    Use for tool calls and notable state changes.
 *
 *  The two modes cooperate: an event clears the current ticker, writes the
 *  event on its own line, and the next status tick redraws the ticker below.
 *  That gives the user a visible history of what the planner did, with a live
 *  "now" indicator that always stays pinned at the bottom. */
export function makeProgressLog(): (text: string, kind?: "status" | "event") => void {
  let frame = 0;
  return (text: string, kind: "status" | "event" = "status") => {
    const maxW = termWidth();
    const clean = text.replace(/\n/g, " ");
    const line = clean.length > maxW ? clean.slice(0, maxW - 1) + "…" : clean;
    if (kind === "event") {
      process.stdout.write(`\x1B[2K\r  ${chalk.cyan("›")} ${chalk.dim(line)}\n`);
      return;
    }
    const spin = chalk.cyan(BRAILLE[frame++ % BRAILLE.length]);
    process.stdout.write(`\x1B[2K\r  ${spin} ${chalk.dim(line)}`);
  };
}
