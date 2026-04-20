import { runPlannerQuery, attemptJsonParse, postProcess } from "./query.js";
import { contextConstraintNote } from "../core/models.js";
import { createTurn, beginTurn, endTurn } from "../core/turns.js";
import { renderPrompt } from "../prompts/load.js";
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
const DEFAULT_CAPS = {
    milestones: 2000, designs: 1500, reflections: 1000,
    verifications: 1000, previousRuns: 800, userGuidance: 4000,
};
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
function renderSteer(args) {
    const cap = (s, max) => !s ? "" : s.length > max ? s.slice(0, max) + "\n...(truncated)" : s;
    const useShort = args.history.length >= 3;
    return renderPrompt("30_wave/30-1_steer", {
        vars: {
            userGuidance: cap(args.runMemory?.userGuidance, args.caps.userGuidance),
            objective: args.objective,
            goal: args.runMemory?.goal,
            status: args.runMemory?.status,
            milestones: cap(args.runMemory?.milestones, args.caps.milestones),
            previousRuns: cap(args.runMemory?.previousRuns, args.caps.previousRuns),
            recentText: buildRecentText(args.history, args.keepLastWaves),
            designs: cap(args.runMemory?.designs, args.caps.designs),
            reflections: cap(args.runMemory?.reflections, args.caps.reflections),
            verifications: cap(args.runMemory?.verifications, args.caps.verifications),
            remainingBudget: args.remainingBudget,
            concurrency: args.concurrency,
            contextConstraintNote: contextConstraintNote(args.workerModel),
            waveCount: args.history.length,
            shortArchetypes: useShort,
            longArchetypes: !useShort,
            fastModel: args.fastModel ?? "not set",
            workerModel: args.workerModel,
        },
    });
}
export async function steerWave(objective, history, remainingBudget, cwd, plannerModel, workerModel, fastModel, concurrency, onLog, runMemory, transcriptName = "steer") {
    const base = { objective, history, remainingBudget, workerModel, fastModel, concurrency, runMemory };
    let caps = { ...DEFAULT_CAPS };
    let keepLastWaves = 3;
    let prompt = renderSteer({ ...base, caps, keepLastWaves });
    // ── Hard 6 KB budget: progressively tighten until we fit ──
    let trimmed = 0;
    const trimSteps = [
        () => { keepLastWaves = 2; },
        () => { caps = { ...caps, milestones: Math.min(caps.milestones, 1000) }; },
        () => { caps = { ...caps, designs: Math.min(caps.designs, 1000) }; },
        () => { caps = { ...caps, reflections: Math.min(caps.reflections, 500) }; },
        () => { caps = { ...caps, verifications: Math.min(caps.verifications, 500) }; },
        () => { caps = { ...caps, previousRuns: Math.min(caps.previousRuns, 400) }; },
    ];
    for (const step of trimSteps) {
        if (prompt.length <= PROMPT_BUDGET)
            break;
        step();
        const next = renderSteer({ ...base, caps, keepLastWaves });
        if (next.length < prompt.length) {
            prompt = next;
            trimmed++;
        }
    }
    if (trimmed > 0) {
        onLog(`Steering prompt trimmed ${trimmed} blocks (${prompt.length}/${PROMPT_BUDGET} chars)`, "event");
    }
    // ── Non-Claude planner JSON hardening ──
    if (!/^claude/i.test(plannerModel)) {
        prompt = renderPrompt("_shared/non-claude-json-wrap", { vars: { innerPrompt: prompt } });
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
        const retryText = await runPlannerQuery(renderPrompt("30_wave/30-7_steer-retry", { vars: { snippet } }), { cwd, model: plannerModel, outputFormat: STEER_SCHEMA, transcriptName: `${transcriptName}-retry`, turnId: turn.id }, onLog);
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
