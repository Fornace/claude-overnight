export interface Task {
    id: string;
    prompt: string;
    cwd?: string;
    model?: string;
}
export interface TaskFile {
    concurrency?: number;
    cwd?: string;
    model?: string;
    allowedTools?: string[];
    tasks: (string | {
        prompt: string;
        cwd?: string;
        model?: string;
    })[];
}
export type AgentStatus = "pending" | "running" | "done" | "error";
export interface AgentState {
    id: number;
    task: Task;
    status: AgentStatus;
    currentTool?: string;
    lastText?: string;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    toolCalls: number;
    costUsd?: number;
    branch?: string;
    filesChanged?: number;
}
export interface LogEntry {
    time: number;
    agentId: number;
    text: string;
}
export type SwarmPhase = "planning" | "running" | "merging" | "done";
