import { query } from "@anthropic-ai/claude-agent-sdk";
/**
 * Coordinator: analyzes the codebase, breaks objective into parallel tasks.
 */
export async function planTasks(objective, cwd, model, onLog) {
    onLog("Analyzing codebase...");
    let resultText = "";
    for await (const msg of query({
        prompt: `You are a task coordinator for a parallel agent swarm. Analyze this codebase and break the following objective into independent tasks.

Objective: ${objective}

Requirements:
- Each task MUST be independent — no task depends on another
- Each task should target specific files/areas to avoid merge conflicts
- Be specific: mention exact file paths, function names, what to change
- Keep tasks focused: one logical change per task
- Aim for 3-15 tasks depending on scope

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "In src/foo.ts, refactor the bar() function to..." },
    { "prompt": "Add unit tests for the baz module in test/baz.test.ts..." }
  ]
}`,
        options: {
            cwd,
            model,
            tools: ["Read", "Glob", "Grep", "Bash"],
            allowedTools: ["Read", "Glob", "Grep", "Bash"],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            persistSession: false,
            includePartialMessages: true,
        },
    })) {
        // Track planner's tool use for the UI
        if (msg.type === "stream_event") {
            const ev = msg.event;
            if (ev?.type === "content_block_start" &&
                ev.content_block?.type === "tool_use") {
                onLog(ev.content_block.name);
            }
        }
        if (msg.type === "result") {
            if (msg.subtype === "success") {
                resultText = msg.result || "";
            }
            else {
                throw new Error(`Planner failed: ${msg.subtype}`);
            }
        }
    }
    // Extract JSON from result — handle markdown fences or raw JSON
    const cleaned = resultText.replace(/```json?\s*/g, "").replace(/```/g, "");
    const jsonMatch = cleaned.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (!jsonMatch)
        throw new Error("Planner did not return valid task JSON");
    const parsed = JSON.parse(jsonMatch[0]);
    const tasks = (parsed.tasks || []).map((t, i) => ({
        id: String(i),
        prompt: typeof t === "string" ? t : t.prompt,
    }));
    if (tasks.length === 0)
        throw new Error("Planner generated 0 tasks");
    onLog(`Generated ${tasks.length} tasks`);
    return tasks;
}
