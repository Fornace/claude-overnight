/**
 * Scoring logic for prompt evolution benchmarks.
 *
 * Split in three concerns, reported as separate dimensions so a JSON
 * discipline failure never masquerades as a content failure:
 *   parse   — was the output valid JSON (when expected)?
 *   schema  — did the object include the required fields?
 *   content — are the tasks independent / specific / in a sane budget band?
 *
 * Content is the only dimension that can optionally be replaced by an
 * llm-judge score (see llm-judge.ts). Everything else stays deterministic
 * so we can diff runs without paying for a judge call.
 */

import type { BenchmarkCase, ScoreDimensions, EvaluationResult } from "./types.js";

export interface ScoreInputs {
  /** Optional llm-judge output that overrides the deterministic `content` score. */
  judgeContent?: number;
  /** Judge's human-readable justification, attached to the result. */
  judgeJustification?: string;
  /** Model identity for multi-model runs. */
  model?: string;
}

export function scoreOutput(
  raw: string,
  parsed: unknown,
  costUsd: number,
  durationMs: number,
  c: BenchmarkCase,
  inputs: ScoreInputs = {},
): EvaluationResult {
  const notes: string[] = [];
  const cr = c.criteria;

  // ── Parse ──
  let parse = 0;
  if (parsed !== null && typeof parsed === "object") {
    parse = 1;
  } else {
    notes.push("Output is not valid JSON or not an object");
  }

  // ── Schema ──
  let schema = 0;
  if (parse === 1 && cr.requiredJsonFields && cr.requiredJsonFields.length > 0) {
    const obj = parsed as Record<string, unknown>;
    const missing = cr.requiredJsonFields.filter((f) => !(f in obj));
    if (missing.length === 0) {
      schema = 1;
    } else {
      schema = (cr.requiredJsonFields.length - missing.length) / cr.requiredJsonFields.length;
      notes.push(`Missing JSON fields: ${missing.join(", ")}`);
    }
  } else if (!cr.requiredJsonFields || cr.requiredJsonFields.length === 0) {
    schema = 1;
  }

  // ── Content ──
  // Default: heuristic sub-scores (budget sanity, independence, specificity).
  // When an llm-judge score is supplied, it REPLACES the heuristic content —
  // the judge reads the objective and the output, which is strictly more signal.
  let content = 0;
  if (inputs.judgeContent != null) {
    content = clamp01(inputs.judgeContent);
  } else if (parse === 1 && schema === 1) {
    content = heuristicContent(parsed as Record<string, unknown>, c, notes);
  }

  // ── Cost efficiency ──
  // $0.001 → 0.91, $0.01 → 0.5, $0.10 → 0.09
  const costEfficiency = 1 / (1 + costUsd * 100);

  // ── Speed ──
  // 1s → 0.91, 10s → 0.5, 60s → 0.14
  const speed = 1 / (1 + durationMs / 10_000);

  return {
    caseHash: c.hash,
    caseName: c.name,
    variantId: "",
    promptPath: c.promptPath,
    rawOutput: raw,
    parsedOutput: parsed,
    costUsd,
    durationMs,
    scores: { parse, schema, content, costEfficiency, speed },
    notes,
    model: inputs.model,
    judgeJustification: inputs.judgeJustification,
  };
}

function heuristicContent(
  obj: Record<string, unknown>,
  c: BenchmarkCase,
  notes: string[],
): number {
  const cr = c.criteria;
  const subScores: number[] = [];
  const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];

  // Budget-band sanity. If the case's vars carry a `budget`, we expect the
  // output to land within an order of magnitude. This is a cheap sanity gate,
  // not a grade — if the prompt claims "budget=5" and returns 0 or 50 tasks,
  // something is broken. The narrow judgment is the llm-judge's job.
  const budget = typeof c.vars.budget === "number" ? c.vars.budget : undefined;
  if (budget != null && budget > 0) {
    if (tasks.length === 0) {
      subScores.push(0);
      notes.push(`Empty tasks array for budget=${budget}`);
    } else if (tasks.length > budget * 5) {
      subScores.push(0.2);
      notes.push(`Task count ${tasks.length} vastly exceeds budget=${budget}`);
    } else {
      subScores.push(1);
    }
  }

  if (cr.independentTasks && tasks.length > 0) {
    const dependencyWords = /\b(after|before|then|depends?\s+on|follow|subsequent|once\s+.*\s+done|upon\s+completion)\b/gi;
    const dependent = tasks.filter((t: unknown) => {
      const text = typeof t === "string" ? t : (t as { prompt?: string })?.prompt ?? "";
      return dependencyWords.test(text);
    });
    if (dependent.length === 0) {
      subScores.push(1);
    } else {
      subScores.push(Math.max(0, 1 - dependent.length / tasks.length));
      notes.push(`${dependent.length} task(s) appear to have dependencies`);
    }
  }

  if (cr.specificTasks && tasks.length > 0) {
    const filePattern = /\b(src\/|lib\/|app\/|test\/|spec\/|\.[tj]sx?\b|\.py\b|\.go\b|\.rs\b)/i;
    const funcPattern = /\b(function|method|class|component|module|route|handler)\b|\(\s*\)/i;
    const specific = tasks.filter((t: unknown) => {
      const text = typeof t === "string" ? t : (t as { prompt?: string })?.prompt ?? "";
      return filePattern.test(text) || funcPattern.test(text);
    });
    subScores.push(specific.length / tasks.length);
    if (specific.length < tasks.length) {
      notes.push(`${tasks.length - specific.length} task(s) lack file/function specificity`);
    }
  }

  if (subScores.length === 0) return 1; // nothing required → content is satisfied
  return subScores.reduce((a, b) => a + b, 0) / subScores.length;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Geometric mean of score dimensions — rewards balanced performance */
export function gmean(scores: ScoreDimensions): number {
  const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
  const product = vals.reduce((a, b) => a * Math.max(b, 0.001), 1);
  return Math.pow(product, 1 / vals.length);
}

/** Arithmetic mean for quick human reading */
export function amean(scores: ScoreDimensions): number {
  const vals = [scores.parse, scores.schema, scores.content, scores.costEfficiency, scores.speed];
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Aggregate multiple runs of the same (variant, case) into mean + stddev. */
export function aggregateReps(results: EvaluationResult[]): {
  mean: ScoreDimensions;
  stddev: ScoreDimensions;
} {
  const n = results.length;
  if (n === 0) {
    const zero = { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 };
    return { mean: zero, stddev: zero };
  }
  const keys: Array<keyof ScoreDimensions> = ["parse", "schema", "content", "costEfficiency", "speed"];
  const mean = {} as ScoreDimensions;
  const stddev = {} as ScoreDimensions;
  for (const k of keys) {
    const vals = results.map((r) => r.scores[k]);
    const m = vals.reduce((a, b) => a + b, 0) / n;
    mean[k] = m;
    if (n === 1) {
      stddev[k] = 0;
    } else {
      const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / n;
      stddev[k] = Math.sqrt(variance);
    }
  }
  return { mean, stddev };
}
