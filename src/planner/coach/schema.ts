export type CoachScope =
  | "bugfix" | "feature-add" | "refactor" | "audit-and-fix"
  | "migration" | "research-and-implement" | "polish-and-verify";

export type ChecklistLevel = "blocking" | "warning" | "info";
export type ChecklistRemediation =
  | "provider:anthropic" | "provider:cursor"
  | "git:dirty" | "git:branch"
  | "env:missing" | "port:busy" | "none";

export interface ChecklistItem {
  id: string;
  level: ChecklistLevel;
  title: string;
  detail: string;
  remediation: ChecklistRemediation;
}

export interface CoachRecommended {
  budget: number;
  concurrency: number;
  plannerModel: string;
  workerModel: string;
  fastModel: string | null;
  flex: boolean;
  usageCap: number | null;
}

export interface CoachResult {
  improvedObjective: string;
  scope: CoachScope;
  recommended: CoachRecommended;
  checklist: ChecklistItem[];
  rationale: string;
}

export const COACH_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "improvedObjective", "rationale", "recommended", "checklist", "questions"],
    properties: {
      scope: { type: "string", enum: ["bugfix", "feature-add", "refactor", "audit-and-fix", "migration", "research-and-implement", "polish-and-verify"] },
      improvedObjective: { type: "string" },
      rationale: { type: "string" },
      recommended: {
        type: "object",
        additionalProperties: false,
        required: ["budget", "concurrency", "plannerModel", "workerModel", "fastModel", "flex", "usageCap"],
        properties: {
          budget: { type: "integer", minimum: 1 },
          concurrency: { type: "integer", minimum: 1, maximum: 12 },
          plannerModel: { type: "string" },
          workerModel: { type: "string" },
          fastModel: { type: ["string", "null"] },
          flex: { type: "boolean" },
          usageCap: { type: ["number", "null"] },
        },
      },
      checklist: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "level", "title", "detail", "remediation"],
          properties: {
            id: { type: "string" },
            level: { type: "string", enum: ["blocking", "warning", "info"] },
            title: { type: "string" },
            detail: { type: "string" },
            remediation: { type: "string", enum: ["provider:anthropic", "provider:cursor", "git:dirty", "git:branch", "env:missing", "port:busy", "none"] },
          },
        },
      },
      questions: { type: "array", items: { type: "string" } },
    },
  },
};

export function validateCoachOutput(raw: unknown): CoachResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const scopes: CoachScope[] = ["bugfix", "feature-add", "refactor", "audit-and-fix", "migration", "research-and-implement", "polish-and-verify"];
  if (typeof r.scope !== "string" || !scopes.includes(r.scope as CoachScope)) return null;
  if (typeof r.improvedObjective !== "string" || r.improvedObjective.trim().length < 5) return null;
  if (typeof r.rationale !== "string") return null;
  const rec = r.recommended as Record<string, unknown> | undefined;
  if (!rec || typeof rec !== "object") return null;
  const budget = Number(rec.budget);
  const concurrency = Number(rec.concurrency);
  if (!Number.isFinite(budget) || budget < 1) return null;
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 12) return null;
  if (typeof rec.plannerModel !== "string" || typeof rec.workerModel !== "string") return null;
  const fastModel = rec.fastModel == null ? null : (typeof rec.fastModel === "string" ? rec.fastModel : null);
  if (typeof rec.flex !== "boolean") return null;
  const usageCap = rec.usageCap == null ? null : (typeof rec.usageCap === "number" && rec.usageCap > 0 && rec.usageCap <= 1 ? rec.usageCap : null);

  const rawChecklist = Array.isArray(r.checklist) ? r.checklist : [];
  const checklist: ChecklistItem[] = [];
  for (const item of rawChecklist) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (typeof it.id !== "string" || typeof it.title !== "string" || typeof it.detail !== "string") continue;
    const levels: ChecklistLevel[] = ["blocking", "warning", "info"];
    if (typeof it.level !== "string" || !levels.includes(it.level as ChecklistLevel)) continue;
    const rems: ChecklistRemediation[] = ["provider:anthropic", "provider:cursor", "git:dirty", "git:branch", "env:missing", "port:busy", "none"];
    const remediation = (typeof it.remediation === "string" && rems.includes(it.remediation as ChecklistRemediation))
      ? (it.remediation as ChecklistRemediation) : "none";
    checklist.push({ id: it.id, level: it.level as ChecklistLevel, title: it.title, detail: it.detail, remediation });
  }

  return {
    improvedObjective: r.improvedObjective.trim(),
    scope: r.scope as CoachScope,
    rationale: r.rationale.trim(),
    recommended: {
      budget: Math.round(budget),
      concurrency: Math.round(concurrency),
      plannerModel: rec.plannerModel,
      workerModel: rec.workerModel,
      fastModel,
      flex: rec.flex,
      usageCap,
    },
    checklist,
  };
}
