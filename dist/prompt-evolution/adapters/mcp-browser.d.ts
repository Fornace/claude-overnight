/**
 * MCP-browser prompt adapter.
 *
 * MCP-browser stores prompts as inline template literals in
 * platform/supervisor/gemini-client.ts. This adapter:
 * 1. Extracts those prompt strings by parsing the TS file
 * 2. Defines benchmark cases for each prompt type
 * 3. Provides repo contexts for planning/refinement evaluation
 *
 * The prompts are evaluated by sending them to a model (via OpenRouter
 * or any Anthropic-compatible proxy) and scoring the structured output.
 */
import type { BenchmarkCase } from "../types.js";
/** Prompt kinds we can benchmark */
export type McpPromptKind = "planning" | "review" | "evolution" | "goal-refinement" | "plan-supervision" | "simple-supervision" | "stuck-analysis";
/** Extract a const prompt string from gemini-client.ts by name */
export declare function extractPrompt(kind: McpPromptKind): string;
/** Build a synthetic user prompt for a given kind and scenario */
export declare function buildUserPrompt(kind: McpPromptKind, scenario: McpScenario): string;
export interface McpScenario {
    name: string;
    repoContext?: RepoContext;
    stepContext?: StepContext;
    terminalContext?: TerminalContext;
    reviewContext?: ReviewContext;
    evolutionContext?: EvolutionContext;
    goalContext?: GoalContext;
}
export interface RepoContext {
    goal: string;
    fileTree: string;
    readmeSnippet: string;
    hasCiCd: boolean;
}
export interface StepContext {
    stepTitle: string;
    stepDescription: string;
    acceptanceCriteria: string[];
    phaseTitle: string;
    progress: string;
}
export interface TerminalContext {
    state: "idle" | "error" | "context_limit" | "completed" | "working";
    recentOutput: string;
    projectGoal: string;
}
export interface ReviewContext {
    stepTitle: string;
    stepDescription: string;
    acceptanceCriteria: string[];
    terminalOutput: string;
}
export interface EvolutionContext {
    completedPlanSummary: string;
    reviewNotes: string;
    evolutionNumber: number;
}
export interface GoalContext {
    originalTitle: string;
    originalDescription: string;
    gitHistory: string;
    fileTree: string;
}
export declare const PLANNING_SCENARIOS: McpScenario[];
export declare const REVIEW_SCENARIOS: McpScenario[];
export declare const SUPERVISION_SCENARIOS: McpScenario[];
export declare const STUCK_SCENARIOS: McpScenario[];
/** Convert scenarios to benchmark cases for a given prompt kind */
export declare function scenariosToCases(kind: McpPromptKind, scenarios: McpScenario[]): BenchmarkCase[];
export declare function hydrateCases(cases: BenchmarkCase[]): BenchmarkCase[];
