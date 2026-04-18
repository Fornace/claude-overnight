import type { Task, SteerResult, WaveSummary } from "../core/types.js";
import { runPlannerQuery, attemptJsonParse, postProcess, type PlannerLog } from "./query.js";
import { createTurn, beginTurn, endTurn } from "../core/turns.js";

// Verifier schema — same shape as STEER_SCHEMA plus a `verifiedIds` list so
// the wave-loop can tell which of the prior wave's tasks actually shipped.
export const VERIFY_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      done: { type: "boolean" },
      reasoning: { type: "string" },
      statusUpdate: { type: "string" },
      estimatedSessionsRemaining: { type: "number" },
      verifiedCount: { type: "number" },
      retryCount: { type: "number" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            model: { type: "string" },
            noWorktree: { type: "boolean" },
            type: { type: "string", enum: ["execute", "explore", "critique", "synthesize", "verify", "user-test", "polish"] },
            postcondition: { type: "string" },
          },
          required: ["prompt"],
        },
      },
    },
    required: ["done", "tasks", "reasoning", "statusUpdate", "estimatedSessionsRemaining"],
  },
};

function renderLastWave(w: WaveSummary | undefined): string {
  if (!w) return "(first wave — nothing to verify yet)";
  const lines = w.tasks.map(t => {
    const files = t.filesChanged ? ` (${t.filesChanged} files)` : " (0 files)";
    const err = t.error ? ` — ${t.error}` : "";
    return `  - [${t.status}] ${t.prompt.slice(0, 160)}${files}${err}`;
  }).join("\n");
  return `Wave ${w.wave + 1}:\n${lines}`;
}

/**
 * Verify the previous wave and compose the next fixed batch of pending tasks.
 *
 * Unlike `steerWave`, the verifier does not invent new tasks — it:
 *   1. Runs the project's build/smoke checks.
 *   2. Fixes shallow regressions in the last wave (edits directly).
 *   3. Picks the next N pending tasks from the user's fixed plan.
 *
 * The model has full tool access so it can actually repair broken commits,
 * not just report on them.
 */
export async function verifyWave(
  objective: string,
  pendingTasks: Task[],
  lastWave: WaveSummary | undefined,
  remainingBudget: number,
  cwd: string,
  plannerModel: string,
  concurrency: number,
  onLog: PlannerLog,
  transcriptName: string = "verify",
): Promise<SteerResult> {
  const pendingList = pendingTasks.length > 0
    ? pendingTasks.map((t, i) => `  ${i + 1}. ${t.prompt.slice(0, 200)}`).join("\n")
    : "(none — every task from the original plan has been attempted)";

  const prompt = `You are the verifier + fix gate between waves of a fixed-plan execution.

Objective: ${objective}

## What just happened
${renderLastWave(lastWave)}

## Remaining plan (pending tasks, in order)
${pendingList}

## Your job

1. Run the project's build and smoke checks. Use the tools you have (Bash, Read, Grep, Edit, Write).
2. For any regression the last wave introduced, make the fix directly. Don't delegate a fix to the next wave if you can do it in two edits.
3. Compose the next batch of pending tasks to dispatch — pick tasks with non-overlapping file scopes so ${concurrency} can run in parallel.
4. If the plan is complete AND the build passes AND one verify task has confirmed the app runs, set done=true.

## Output

Respond with ONLY a JSON object (no markdown fences):
{"done":boolean,"reasoning":"...","statusUpdate":"REQUIRED","estimatedSessionsRemaining":N,"verifiedCount":N,"retryCount":N,"tasks":[{"prompt":"...","type":"execute","postcondition":"..."}]}

Remaining budget: ${remainingBudget} agent sessions. Include retries inside tasks[] (same format) if a pending step needs a second attempt with corrected context.`;

  onLog("Verifying last wave…", "status");
  const turn = createTurn("steer", `Verify wave`, `verify-${lastWave?.wave ?? 0}`, plannerModel);
  beginTurn(turn);

  const resultText = await runPlannerQuery(prompt, {
    cwd, model: plannerModel, outputFormat: VERIFY_SCHEMA,
    transcriptName, turnId: turn.id, maxTurns: 80,
  }, onLog);

  const parsed = attemptJsonParse(resultText);
  if (!parsed) {
    endTurn(turn, "error");
    throw new Error(`Could not parse verifier response (${resultText.length} chars): ${resultText.slice(0, 120)}`);
  }

  const isDone = parsed.done === true;
  const statusUpdate = parsed.statusUpdate || undefined;
  const estRaw = parsed.estimatedSessionsRemaining;
  const estimatedSessionsRemaining = typeof estRaw === "number" && estRaw >= 0 ? Math.round(estRaw) : undefined;

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
    ...(t.noWorktree && { noWorktree: true }),
    ...(t.type && { type: t.type }),
    ...(typeof t.postcondition === "string" && t.postcondition.trim() && { postcondition: t.postcondition.trim() }),
  }));

  tasks = postProcess(tasks, remainingBudget, onLog);
  endTurn(turn, tasks.length === 0 && !isDone ? "error" : "done");

  if (isDone) {
    return {
      done: true, tasks: [], reasoning: parsed.reasoning || "Plan complete and verified",
      statusUpdate, estimatedSessionsRemaining: estimatedSessionsRemaining ?? 0,
    };
  }

  return {
    done: tasks.length === 0, tasks,
    reasoning: parsed.reasoning || "", statusUpdate, estimatedSessionsRemaining,
  };
}
