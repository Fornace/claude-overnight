import type { AITurn, AITurnPhase, AITurnStatus } from "./types.js";

/** Shared registry of all AI turns in the current run. */
const turns: AITurn[] = [];
let focusedIndex = 0;

export function createTurn(phase: AITurnPhase, label: string, id: string, model?: string): AITurn {
  const turn: AITurn = { id, phase, label, model, status: "pending" };
  turns.push(turn);
  return turn;
}

export function beginTurn(turn: AITurn): void {
  turn.status = "running";
  turn.startedAt = Date.now();
}

export function endTurn(turn: AITurn, status: AITurnStatus = "done"): void {
  turn.status = status;
  turn.finishedAt = Date.now();
}

export function updateTurn(turn: AITurn, patch: Partial<AITurn>): void {
  Object.assign(turn, patch);
}

export function allTurns(): readonly AITurn[] { return turns; }

/** Get the currently focused turn (for context meter display). */
export function focusedTurn(): AITurn | undefined {
  if (turns.length === 0) return undefined;
  if (focusedIndex < 0 || focusedIndex >= turns.length) {
    focusedIndex = Math.max(0, turns.length - 1);
  }
  return turns[focusedIndex];
}

export function cycleFocused(delta: number): void {
  if (turns.length === 0) return;
  focusedIndex = ((focusedIndex + delta) % turns.length + turns.length) % turns.length;
}

export function getTurn(id: string): AITurn | undefined {
  return turns.find(t => t.id === id);
}

/** Find the running turn with the highest absolute context token count. */
export function peakContextTurn(): AITurn | undefined {
  let best: AITurn | undefined;
  let bestRatio = 0;
  for (const t of turns) {
    if (t.status !== "running") continue;
    const tok = t.contextTokens ?? 0;
    if (tok <= 0) continue;
    if (!best || tok > bestRatio) { best = t; bestRatio = tok; }
  }
  return best;
}

/** Reset all state (for test isolation). */
export function resetTurns(): void { turns.length = 0; focusedIndex = 0; }
