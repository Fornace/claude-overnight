import type { Task } from "../core/types.js";
import { queryAbEligibleSkills, markAbTrial, recordEvent } from "./index-db.js";

export interface AbAssignment {
  skill: string;
  treatmentTaskIds: string[];
  controlTaskIds: string[];
  wave: number;
}

/**
 * Pick one skill for A/B testing and assign treatment/control arms.
 * Returns null if no eligible skill or insufficient agents.
 * Pure — reads DB and returns a decision without mutating anything.
 */
export function pickAbSkill(opts: {
  fingerprint: string;
  tasks: Task[];
  wave: number;
}): AbAssignment | null {
  const eligible = queryAbEligibleSkills(opts.fingerprint);
  if (eligible.length === 0) return null;

  // Need at least 2 tasks to form a pair
  if (opts.tasks.length < 2) return null;

  // Pair picker: prefer tasks with matching groupId, fallback to first two
  let treatmentIds: string[];
  let controlIds: string[];

  const byGroup = new Map<string, string[]>();
  for (const t of opts.tasks) {
    if (t.groupId) {
      const group = byGroup.get(t.groupId) ?? [];
      group.push(t.id);
      byGroup.set(t.groupId, group);
    }
  }

  // Find a group with >= 2 tasks
  for (const [, ids] of byGroup) {
    if (ids.length >= 2) {
      treatmentIds = [ids[0]];
      controlIds = [ids[1]];
      return assign(opts, eligible[0].name, treatmentIds, controlIds);
    }
  }

  // Fallback: any two tasks
  treatmentIds = [opts.tasks[0].id];
  controlIds = [opts.tasks[1].id];
  return assign(opts, eligible[0].name, treatmentIds, controlIds);
}

function assign(
  opts: { fingerprint: string; tasks: Task[]; wave: number },
  skillName: string,
  treatmentIds: string[],
  controlIds: string[],
): AbAssignment {
  // Mutate task copies to carry A/B arm info through to agent-run
  for (const t of opts.tasks) {
    if (treatmentIds.includes(t.id)) {
      t.abArm = "treatment";
    } else if (controlIds.includes(t.id)) {
      t.abArm = "control";
      t.abExcludeSkill = skillName;
    }
  }

  markAbTrial(skillName);

  return {
    skill: skillName,
    treatmentTaskIds: treatmentIds,
    controlTaskIds: controlIds,
    wave: opts.wave,
  };
}

/** Cost attribution sanity clamp — max $2.00 per event. */
const COST_CLAMP = 2.0;

/**
 * Record A/B outcome after wave verification.
 * Writes skill_events rows for the trial outcome and cost attribution.
 */
export function recordAbOutcome(opts: {
  runId: string;
  wave: number;
  assignment: AbAssignment;
  treatmentScore: number;
  controlScore: number;
  treatmentFilesChanged: number;
  controlFilesChanged: number;
  treatmentCostUsd: number;
  controlCostUsd: number;
}): void {
  const { runId, wave, assignment, treatmentScore, controlScore, treatmentCostUsd, controlCostUsd } = opts;

  const tWin = treatmentScore > controlScore;
  const cWin = controlScore > treatmentScore;

  if (tWin) {
    recordEvent(runId, wave, assignment.skill, "win", undefined, `ab-vs-${assignment.controlTaskIds.join(",")}`);
  } else if (cWin) {
    recordEvent(runId, wave, assignment.skill, "loss", undefined, `ab-vs-${assignment.controlTaskIds.join(",")}`);
  } else {
    recordEvent(runId, wave, assignment.skill, "tie", undefined, "ab-inconclusive");
  }

  // Cost attribution — only when outcomes diverged
  if (tWin !== cWin) {
    const delta = treatmentCostUsd - controlCostUsd;
    const clamped = Math.max(-COST_CLAMP, Math.min(COST_CLAMP, delta));
    if (tWin && delta < 0) {
      // Treatment won AND spent less → cost saved
      recordEvent(runId, wave, assignment.skill, "cost_saved", Math.abs(clamped), `ab-cost-saved-vs-${assignment.controlTaskIds.join(",")}`);
    } else if (tWin && delta >= 0) {
      // Treatment won but spent more — no cost_saved, just the win
    } else if (cWin && delta > 0) {
      // Treatment lost AND spent more → cost burned
      recordEvent(runId, wave, assignment.skill, "cost_burned", clamped, `ab-cost-burned-vs-${assignment.controlTaskIds.join(",")}`);
    } else if (cWin && delta <= 0) {
      // Treatment lost but spent less — no cost_burned
    }
  }
}
