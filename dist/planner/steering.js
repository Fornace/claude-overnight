import { runPlannerQuery, attemptJsonParse, postProcess } from "./query.js";
import { contextConstraintNote } from "../core/models.js";
import { DESIGN_THINKING } from "./planner.js";
import { createTurn, beginTurn, endTurn } from "../core/turns.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTranscriptRunDir } from "../core/transcripts.js";
export const STEER_SCHEMA = {
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
                    properties: { prompt: { type: "string" }, model: { type: "string" }, noWorktree: { type: "boolean" }, type: { type: "string", enum: ["execute", "explore", "critique", "synthesize", "verify", "user-test", "polish"] }, postcondition: { type: "string" } },
                    required: ["prompt"],
                },
            },
        },
        required: ["done", "tasks", "reasoning", "statusUpdate", "estimatedSessionsRemaining"],
    },
};
const PROMPT_BUDGET = 6000;
/** Build a compact wave summary; keepLast controls how many recent waves to include. */
function buildRecentText(history, keepLast) {
    const recentWaves = history.slice(-keepLast);
    return recentWaves.length > 0 ? recentWaves.map(w => {
        const lines = w.tasks.map(t => {
            const isExecute = !t.type || t.type === "execute";
            const files = t.filesChanged ? ` (${t.filesChanged} files)` : isExecute ? " (0 files)" : " (read-only)";
            const err = t.error ? `  -- ${t.error}` : "";
            return `  - [${t.status}] ${t.prompt.slice(0, 120)}${files}${err}`;
        }).join("\n");
        const zeroExecute = w.tasks.filter(t => t.status === "done" && (!t.type || t.type === "execute") && !t.filesChanged).length;
        const totalExecute = w.tasks.filter(t => !t.type || t.type === "execute").length;
        const warn = totalExecute > 0 && zeroExecute > totalExecute / 2 ? `\n  ⚠ ${zeroExecute}/${totalExecute} execute tasks changed 0 files  -- tasks may be mis-scoped or blocked` : "";
        return `Wave ${w.wave + 1}:\n${lines}${warn}`;
    }).join("\n\n") : "(first wave)";
}
export async function steerWave(objective, history, remainingBudget, cwd, plannerModel, workerModel, fastModel, concurrency, onLog, runMemory, transcriptName = "steer") {
    const constraint = contextConstraintNote(workerModel);
    const cap = (s, max) => s.length > max ? s.slice(0, max) + "\n...(truncated)" : s;
    const statusBlock = runMemory?.status ? `\nCurrent project status:\n${runMemory.status}\n` : "";
    const milestoneBlock = runMemory?.milestones ? `\nMilestone snapshots:\n${cap(runMemory.milestones, 2000)}\n` : "";
    const designBlock = runMemory?.designs ? `\nArchitectural research:\n${cap(runMemory.designs, 1500)}\n` : "";
    const reflectionBlock = runMemory?.reflections ? `\nLatest quality reports:\n${cap(runMemory.reflections, 1000)}\n` : "";
    const verificationBlock = runMemory?.verifications ? `\nVerification results (from actually running the app):\n${cap(runMemory.verifications, 1000)}\n` : "";
    const goalBlock = runMemory?.goal ? `\nNorth star  -- what "amazing" means:\n${runMemory.goal}\n` : "";
    const prevRunBlock = runMemory?.previousRuns ? `\nKnowledge from previous runs:\n${cap(runMemory.previousRuns, 800)}\n` : "";
    const guidanceBlock = runMemory?.userGuidance ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUSER DIRECTIVES  -- highest priority\nThese come directly from the user running this session. They override prior assumptions about status, goal, and next steps. Incorporate them into the wave you compose below. If they conflict with earlier decisions, the user wins. Reflect the new direction in statusUpdate so future waves remember.\n\n${cap(runMemory.userGuidance, 4000)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : "";
    // Collapse archetype menu after wave 3 to save ~2 KB
    const archetypesShort = `Archetypes: execute | explore | critique | synthesize | verify | user-test | polish | simplify`;
    const archetypeBlock = history.length >= 3
        ? archetypesShort
        : null;
    let recentText = buildRecentText(history, 3);
    let prompt = `You are the quality director for an autonomous multi-wave agent system. Your job is to push the work toward "amazing," not just "done."
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

Read the codebase efficiently — you have a hard cap of 100 tool calls. Be surgical: check for Postgres imports with targeted greps, read only the files you'll actually modify. Then compose the wave. Assess from the user's chair: does this product do the job someone would hire it for? Does it feel fast, honest, and trustworthy? Not "is the code clean"  -- "would I use this?"

If verification found issues, those are the priority. Fix what's broken before building what's missing. Iterate on what exists before expanding scope.

## Compose the next wave

You have full creative freedom. Design the wave that will have the highest impact right now.${archetypeBlock ? `\n\nUse these archetypes as shorthand — mix, adapt, or invent your own:\n\n${archetypeBlock}` : ` Here are archetypes to draw from  -- mix, adapt, or invent your own:

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

**Simplify**  -- Invoke the 'simplify' skill. It reviews changed code and spawns parallel sub-agents for thorough review.
  Example: 1 agent per wave with task type "review", let the skill handle the rest`}

For non-execute tasks (critique, verify, user-test, synthesize), tell agents to write their output to files in the run directory so findings persist for future waves. Use paths like: .claude-overnight/latest/reflections/wave-n-{topic}.md or .claude-overnight/latest/verifications/wave-n-{topic}.md.

IMPORTANT: You cannot declare "done" unless at least one verification has confirmed the app works. If you're considering done but haven't verified, compose a verification task first.

Respond with ONLY a JSON object (no markdown fences):
{"done":boolean,"reasoning":"...","statusUpdate":"REQUIRED","estimatedSessionsRemaining":N,"tasks":[{"prompt":"...","model":"worker|fast","noWorktree":true/false,"postcondition":"..."}]}

"estimatedSessionsRemaining" is REQUIRED. Your best honest estimate of how many MORE agent sessions (beyond the wave you just composed above) are needed to reach 'amazing'  -- include follow-up fixes, polish, verification, and anything else you'd want before shipping. Be realistic, not optimistic. Use 0 only if truly done.

The "model" field on each task — two kinds of workers. Pick the right one:

**Fast worker — "fast" (${fastModel ?? "not set"})** for well-scoped, mechanical tasks: single-file edits, refactors, renames, read/research, build checks, simple critiques, docs updates.

**Main worker — "worker" (${workerModel})** for tasks that need deeper reasoning: multi-file features, complex logic, architectural changes, ambiguous specs.

When in doubt, pick "fast".

Set "noWorktree": true for verify/user-test tasks.

OPTIONAL "postcondition": a single shell one-liner that exits 0 when the task is truly done. Keep it cheap. Omit for exploratory tasks.

If done: {"done":true,"reasoning":"...","statusUpdate":"...","estimatedSessionsRemaining":0,"tasks":[]}`;
    // ── Hard 6 KB budget: trim non-critical blocks if over limit ──
    let trimmed = 0;
    if (prompt.length > PROMPT_BUDGET) {
        // 1. Keep last 2 waves instead of 3
        recentText = buildRecentText(history, 2);
        prompt = prompt.replace(`Recent waves:\n${buildRecentText(history, 3)}`, `Recent waves:\n${recentText}`);
        trimmed++;
    }
    if (prompt.length > PROMPT_BUDGET && runMemory?.milestones) {
        const old = `\nMilestone snapshots:\n${cap(runMemory.milestones, 2000)}\n`;
        const neu = `\nMilestone snapshots:\n${cap(runMemory.milestones, 1000)}\n`;
        if (old !== neu) {
            prompt = prompt.replace(old, neu);
            trimmed++;
        }
    }
    if (prompt.length > PROMPT_BUDGET && runMemory?.designs) {
        const old = `\nArchitectural research:\n${cap(runMemory.designs, 1500)}\n`;
        const neu = `\nArchitectural research:\n${cap(runMemory.designs, 1000)}\n`;
        if (old !== neu) {
            prompt = prompt.replace(old, neu);
            trimmed++;
        }
    }
    if (prompt.length > PROMPT_BUDGET && runMemory?.reflections) {
        const old = `\nLatest quality reports:\n${cap(runMemory.reflections, 1000)}\n`;
        const neu = `\nLatest quality reports:\n${cap(runMemory.reflections, 500)}\n`;
        if (old !== neu) {
            prompt = prompt.replace(old, neu);
            trimmed++;
        }
    }
    if (prompt.length > PROMPT_BUDGET && runMemory?.verifications) {
        const old = `\nVerification results (from actually running the app):\n${cap(runMemory.verifications, 1000)}\n`;
        const neu = `\nVerification results (from actually running the app):\n${cap(runMemory.verifications, 500)}\n`;
        if (old !== neu) {
            prompt = prompt.replace(old, neu);
            trimmed++;
        }
    }
    if (prompt.length > PROMPT_BUDGET && runMemory?.previousRuns) {
        const old = `\nKnowledge from previous runs:\n${cap(runMemory.previousRuns, 800)}\n`;
        const neu = `\nKnowledge from previous runs:\n${cap(runMemory.previousRuns, 400)}\n`;
        if (old !== neu) {
            prompt = prompt.replace(old, neu);
            trimmed++;
        }
    }
    if (trimmed > 0) {
        onLog(`Steering prompt trimmed ${trimmed} blocks (${prompt.length}/${PROMPT_BUDGET} chars)`, "event");
    }
    // ── Non-Claude planner JSON hardening ──
    if (!/^claude/i.test(plannerModel)) {
        const directive = `OUTPUT: single JSON object. No prose. No markdown fences.`;
        prompt = `${directive}\n\n${prompt}\n\n${directive}`;
    }
    onLog("Assessing...", "status");
    onLog(`Reading codebase  -- wave ${history.length + 1}`, "event");
    const turn = createTurn("steer", `Steer wave ${history.length + 1}`, `steer-${history.length}`, plannerModel);
    beginTurn(turn);
    const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, outputFormat: STEER_SCHEMA, transcriptName, turnId: turn.id, maxTurns: 100 }, onLog);
    const parsed = await (async () => {
        const first = attemptJsonParse(resultText);
        if (first)
            return first;
        onLog(`Steering parse failed (${resultText.length} chars). Asking model to fix...`, "event");
        // C2: persist raw output on parse failure
        const steerDir = getTranscriptRunDir() ? join(getTranscriptRunDir(), "steering") : undefined;
        if (steerDir) {
            try {
                mkdirSync(steerDir, { recursive: true });
            }
            catch { }
            // Extract wave info from transcriptName (e.g. "steer-wave-32-attempt-1")
            const waveMatch = transcriptName.match(/wave-(\d+)-attempt-(\d+)/);
            if (waveMatch) {
                writeFileSync(join(steerDir, `wave-${waveMatch[1]}-attempt-${waveMatch[2]}-raw.txt`), resultText, "utf-8");
            }
        }
        const snippet = resultText.length > 2000 ? resultText.slice(0, 1000) + "\n...\n" + resultText.slice(-800) : resultText;
        const retryText = await runPlannerQuery(`Your previous steering response could not be parsed as JSON. Here is what you returned:\n\n---\n${snippet}\n---\n\nExtract or rewrite the above as ONLY a valid JSON object with this schema: {"done":boolean,"reasoning":"...","statusUpdate":"...","tasks":[{"prompt":"..."}]}\n\nRespond with ONLY the JSON, no markdown fences, no explanation.`, { cwd, model: plannerModel, outputFormat: STEER_SCHEMA, transcriptName: `${transcriptName}-retry`, turnId: turn.id }, onLog);
        const retryParsed = attemptJsonParse(retryText);
        if (retryParsed)
            return retryParsed;
        // C2: persist retry raw output
        if (steerDir) {
            try {
                const waveMatch2 = transcriptName.match(/wave-(\d+)-attempt-(\d+)/);
                if (waveMatch2) {
                    writeFileSync(join(steerDir, `wave-${waveMatch2[1]}-attempt-${waveMatch2[2]}-retry-raw.txt`), retryText, "utf-8");
                }
            }
            catch { }
        }
        throw new Error(`Could not parse steering response after retry (${resultText.length} chars: ${resultText.slice(0, 120)}...)`);
    })();
    const isDone = parsed.done === true;
    const statusUpdate = parsed.statusUpdate || undefined;
    const estRaw = parsed.estimatedSessionsRemaining;
    const estimatedSessionsRemaining = typeof estRaw === "number" && estRaw >= 0 ? Math.round(estRaw) : undefined;
    // Resolve steering role strings ("worker"/"fast"/"planner") to actual model IDs.
    const resolveModel = (role) => {
        switch (role.toLowerCase()) {
            case "worker": return workerModel;
            case "planner": return plannerModel;
            case "fast": return fastModel ?? workerModel;
            default: return role; // already a real model ID
        }
    };
    let tasks = (parsed.tasks || []).map((t, i) => ({
        id: String(i),
        prompt: typeof t === "string" ? t : t.prompt,
        ...(t.model && { model: resolveModel(t.model) }),
        ...(t.noWorktree && { noWorktree: true }),
        ...(t.type && { type: t.type }),
        ...(typeof t.postcondition === "string" && t.postcondition.trim() && { postcondition: t.postcondition.trim() }),
    }));
    tasks = postProcess(tasks, remainingBudget, onLog);
    endTurn(turn, tasks.length === 0 && !isDone ? "error" : "done");
    if (isDone) {
        return { done: true, tasks: [], reasoning: parsed.reasoning || "Objective complete", goalUpdate: parsed.goalUpdate, statusUpdate, estimatedSessionsRemaining: estimatedSessionsRemaining ?? 0 };
    }
    return { done: tasks.length === 0, tasks, reasoning: parsed.reasoning || "", goalUpdate: parsed.goalUpdate, statusUpdate, estimatedSessionsRemaining };
}
