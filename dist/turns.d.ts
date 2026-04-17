import type { AITurn, AITurnPhase, AITurnStatus } from "./types.js";
export declare function createTurn(phase: AITurnPhase, label: string, id: string, model?: string): AITurn;
export declare function beginTurn(turn: AITurn): void;
export declare function endTurn(turn: AITurn, status?: AITurnStatus): void;
export declare function updateTurn(turn: AITurn, patch: Partial<AITurn>): void;
export declare function allTurns(): readonly AITurn[];
/** Get the currently focused turn (for context meter display). */
export declare function focusedTurn(): AITurn | undefined;
export declare function cycleFocused(delta: number): void;
export declare function getTurn(id: string): AITurn | undefined;
/** Find the running turn with the highest absolute context token count. */
export declare function peakContextTurn(): AITurn | undefined;
/** Reset all state (for test isolation). */
export declare function resetTurns(): void;
