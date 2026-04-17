/** Shared registry of all AI turns in the current run. */
const turns = [];
let focusedIndex = 0;
export function createTurn(phase, label, id, model) {
    const turn = { id, phase, label, model, status: "pending" };
    turns.push(turn);
    return turn;
}
export function beginTurn(turn) {
    turn.status = "running";
    turn.startedAt = Date.now();
}
export function endTurn(turn, status = "done") {
    turn.status = status;
    turn.finishedAt = Date.now();
}
export function updateTurn(turn, patch) {
    Object.assign(turn, patch);
}
export function allTurns() { return turns; }
/** Get the currently focused turn (for context meter display). */
export function focusedTurn() {
    if (turns.length === 0)
        return undefined;
    if (focusedIndex < 0 || focusedIndex >= turns.length) {
        focusedIndex = Math.max(0, turns.length - 1);
    }
    return turns[focusedIndex];
}
export function cycleFocused(delta) {
    if (turns.length === 0)
        return;
    focusedIndex = ((focusedIndex + delta) % turns.length + turns.length) % turns.length;
}
export function getTurn(id) {
    return turns.find(t => t.id === id);
}
/** Find the running turn with the highest absolute context token count. */
export function peakContextTurn() {
    let best;
    let bestRatio = 0;
    for (const t of turns) {
        if (t.status !== "running")
            continue;
        const tok = t.contextTokens ?? 0;
        if (tok <= 0)
            continue;
        if (!best || tok > bestRatio) {
            best = t;
            bestRatio = tok;
        }
    }
    return best;
}
/** Reset all state (for test isolation). */
export function resetTurns() { turns.length = 0; focusedIndex = 0; }
