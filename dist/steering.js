import { runPlannerQuery, attemptJsonParse, postProcess } from "./planner-query.js";
import { contextConstraintNote } from "./models.js";
import { DESIGN_THINKING } from "./planner.js";
const STEER_SCHEMA = {
    type: "json_schema",
    schema: {
        type: "object",
        properties: {
            done: { type: "boolean" },
            reasoning: { type: "string" },
            statusUpdate: { type: "string" },
            goalUpdate: { type: "string" },
            estimatedSessionsRemaining: { type: "number" },
            tasks: {
                type: "array",
                items: {
                    type: "object",
                    properties: { prompt: { type: "string" }, model: { type: "string" }, noWorktree: { type: "boolean" } },
                    required: ["prompt"],
                },
            },
        },
        required: ["done", "tasks", "reasoning", "statusUpdate", "estimatedSessionsRemaining"],
    },
};
export async function steerWave(objective, history, remainingBudget, cwd, plannerModel, workerModel, fastModel, permissionMode, concurrency, onLog, runMemory, transcriptName = "steer") {
    const constraint = contextConstraintNote(workerModel);
    const recentWaves = history.slice(-3);
    const recentText = recentWaves.length > 0 ? recentWaves.map(w => {
        const lines = w.tasks.map(t => {
            const files = t.filesChanged ? ` (${t.filesChanged} files)` : " (0 files)";
            const err = t.error ? `  -- ${t.error}` : "";
            return `  - [${t.status}] ${t.prompt.slice(0, 120)}${files}${err}`;
        }).join("\n");
        const zeroChange = w.tasks.filter(t => t.status === "done" && !t.filesChanged).length;
        const warn = zeroChange > w.tasks.length / 2 ? `\n  ⚠ ${zeroChange}/${w.tasks.length} agents changed 0 files  -- tasks may be mis-scoped or blocked` : "";
        return `Wave ${w.wave + 1}:\n${lines}${warn}`;
    }).join("\n\n") : "(first wave)";
    const cap = (s, max) => s.length > max ? s.slice(0, max) + "\n...(truncated)" : s;
    const statusBlock = runMemory?.status ? `\nCurrent project status:\n${runMemory.status}\n` : "";
    const milestoneBlock = runMemory?.milestones ? `\nMilestone snapshots:\n${cap(runMemory.milestones, 4000)}\n` : "";
    const designBlock = runMemory?.designs ? `\nArchitectural research:\n${cap(runMemory.designs, 4000)}\n` : "";
    const reflectionBlock = runMemory?.reflections ? `\nLatest quality reports:\n${cap(runMemory.reflections, 3000)}\n` : "";
    const verificationBlock = runMemory?.verifications ? `\nVerification results (from actually running the app):\n${cap(runMemory.verifications, 3000)}\n` : "";
    const goalBlock = runMemory?.goal ? `\nNorth star  -- what "amazing" means:\n${runMemory.goal}\n` : "";
    const prevRunBlock = runMemory?.previousRuns ? `\nKnowledge from previous runs:\n${cap(runMemory.previousRuns, 3000)}\n` : "";
    const guidanceBlock = runMemory?.userGuidance ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUSER DIRECTIVES  -- highest priority\nThese come directly from the user running this session. They override prior assumptions about status, goal, and next steps. Incorporate them into the wave you compose below. If they conflict with earlier decisions, the user wins. Reflect the new direction in statusUpdate so future waves remember.\n\n${cap(runMemory.userGuidance, 4000)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : "";
    const prompt = `You are the quality director for an autonomous multi-wave agent system. Your job is to push the work toward "amazing," not just "done."
${guidanceBlock}
Objective: ${objective}
${goalBlock}${statusBlock}${milestoneBlock}${prevRunBlock}
Recent waves:
${recentText}
${designBlock}${reflectionBlock}${verificationBlock}
Remaining budget: ${remainingBudget} agent sessions. ${concurrency} agents run in parallel  -- tasks must touch DIFFERENT files.
${constraint}
${DESIGN_THINKING}
Total waves completed: ${history.length}

Read the codebase. Assess from the user's chair: does this product do the job someone would hire it for? Does it feel fast, honest, and trustworthy? Not "is the code clean"  -- "would I use this?"

If verification found issues, those are the priority. Fix what's broken before building what's missing. Iterate on what exists before expanding scope.

## Compose the next wave

You have full creative freedom. Design the wave that will have the highest impact right now. Here are archetypes to draw from  -- mix, adapt, or invent your own:

**Execute**  -- Agents implement concrete changes in parallel. Each touches different files. The bread and butter.
  Example: 5 agents each owning a different feature or fix

**Explore**  -- Multiple agents independently tackle the same problem from different angles. Each writes a design/approach to a separate file. Use when you need creative alternatives before committing.
  Example: 3 agents each design a different navigation approach, writing to designs/nav-{approach}.md

**Critique**  -- Agents review what exists as skeptical experts. They read the codebase and write findings to files. Use after substantial new code ships.
  Example: 1 code quality reviewer, 1 UX reviewer examining flows end-to-end

**Synthesize**  -- An agent reads multiple alternatives or review findings and makes a decision. Writes the chosen approach or prioritized fix list.
  Example: 1 agent reads 3 design docs and writes the implementation plan

**Verify**  -- Agents actually RUN the application: build it, start it, navigate it, click things, try edge cases. They report what works and what's broken. Not code reading  -- real testing. Always set "noWorktree": true so they run in the real project environment (env files, dependencies, config). Tell verify agents: you MUST get the app running and tested  -- do not give up. If auth is required, search the codebase for dev login routes, test tokens, seed users, env vars with keys/secrets, CLI auth commands, or any bypass. If a port is taken, use another. If a dependency is missing, install it. If a build fails, fix it or work around it. Exhaust every option before declaring something impossible.
  Example: 1 agent does end-to-end QA, writing a report with reproduction steps

**User-test**  -- Agents emulate specific user personas interacting with the product. Always set "noWorktree": true. "First-time user who just downloaded this." "Power user trying to do X fast." They test from that perspective and report friction.
  Example: 2 agents, one new user, one power user, each writing a report

**Polish**  -- Agents focus purely on feel: loading states, error messages, micro-interactions, empty states, responsiveness. Not features  -- the texture that makes users trust the product.
  Example: 2 agents, one on happy paths, one on error/edge states

You can combine these. A wave can have 3 execute agents + 1 verification agent. Or 2 divergent explorers. Whatever the situation calls for.

For non-execute tasks (critique, verify, user-test, synthesize), tell agents to write their output to files in the run directory so findings persist for future waves. Use paths like: .claude-overnight/latest/reflections/wave-N-{topic}.md or .claude-overnight/latest/verifications/wave-N-{topic}.md.

IMPORTANT: You cannot declare "done" unless at least one verification has confirmed the app works. If you're considering done but haven't verified, compose a verification task first.

Respond with ONLY a JSON object (no markdown fences):
{
  "done": false,
  "reasoning": "your assessment and why you chose this wave composition",
  "goalUpdate": "optional  -- refine what 'amazing' means as you learn more",
  "statusUpdate": "REQUIRED  -- concise project status: what's built, what works, what's rough, quality level, key gaps. This replaces the previous status.",
  "estimatedSessionsRemaining": 15,
  "tasks": [
    {"prompt": "task instruction...", "model": "worker"},
    {"prompt": "review task...", "model": "planner"},
    {"prompt": "verify the app end-to-end...", "model": "planner", "noWorktree": true}
  ]
}

"estimatedSessionsRemaining" is REQUIRED. Your best honest estimate of how many MORE agent sessions (beyond the wave you just composed above) are needed to reach 'amazing'  -- include follow-up fixes, polish, verification, and anything else you'd want before shipping. Be realistic, not optimistic. Use 0 only if truly done.

The "model" field on each task: use "worker" (${workerModel}) for implementation tasks, "planner" (${plannerModel}) for review/analysis/verification tasks, "fast" (${fastModel ?? workerModel}) for quick, well-scoped changes that will be checked by the worker model in the next wave. Default is "worker".
Set "noWorktree": true for verify/user-test tasks  -- they need the real project directory with env files, dependencies, and local config.

If done: {"done": true, "reasoning": "...", "statusUpdate": "...", "estimatedSessionsRemaining": 0, "tasks": []}`;
    onLog("Assessing...", "status");
    onLog(`Reading codebase  -- wave ${history.length + 1}`, "event");
    const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode, outputFormat: STEER_SCHEMA, transcriptName }, onLog);
    const parsed = await (async () => {
        const first = attemptJsonParse(resultText);
        if (first)
            return first;
        onLog(`Steering parse failed (${resultText.length} chars). Asking model to fix...`, "event");
        const snippet = resultText.length > 2000 ? resultText.slice(0, 1000) + "\n...\n" + resultText.slice(-800) : resultText;
        const retryText = await runPlannerQuery(`Your previous steering response could not be parsed as JSON. Here is what you returned:\n\n---\n${snippet}\n---\n\nExtract or rewrite the above as ONLY a valid JSON object with this schema: {"done":boolean,"reasoning":"...","statusUpdate":"...","tasks":[{"prompt":"..."}]}\n\nRespond with ONLY the JSON, no markdown fences, no explanation.`, { cwd, model: plannerModel, permissionMode, outputFormat: STEER_SCHEMA, transcriptName: `${transcriptName}-retry` }, onLog);
        const retryParsed = attemptJsonParse(retryText);
        if (retryParsed)
            return retryParsed;
        throw new Error(`Could not parse steering response after retry (${resultText.length} chars: ${resultText.slice(0, 120)}...)`);
    })();
    const isDone = parsed.done === true;
    const statusUpdate = parsed.statusUpdate || undefined;
    const estRaw = parsed.estimatedSessionsRemaining;
    const estimatedSessionsRemaining = typeof estRaw === "number" && estRaw >= 0 ? Math.round(estRaw) : undefined;
    if (isDone) {
        return { done: true, tasks: [], reasoning: parsed.reasoning || "Objective complete", goalUpdate: parsed.goalUpdate, statusUpdate, estimatedSessionsRemaining: estimatedSessionsRemaining ?? 0 };
    }
    let tasks = (parsed.tasks || []).map((t, i) => ({
        id: String(i),
        prompt: typeof t === "string" ? t : t.prompt,
        ...(t.model && { model: t.model }),
        ...(t.noWorktree && { noWorktree: true }),
    }));
    tasks = postProcess(tasks, remainingBudget, onLog);
    return { done: tasks.length === 0, tasks, reasoning: parsed.reasoning || "", goalUpdate: parsed.goalUpdate, statusUpdate, estimatedSessionsRemaining };
}
