import { type PlannerLog } from "./planner-query.js";
import type { ProviderConfig } from "../providers/index.js";
export interface UserSettings {
    skipCoach?: boolean;
    lastCoachedAt?: number;
    coachModel?: string;
    coachProviderId?: string;
}
export declare function loadUserSettings(): UserSettings;
export declare function saveUserSettings(s: UserSettings): void;
export declare const COACH_MODEL = "claude-haiku-4-5";
export type CoachPermMode = "auto" | "bypassPermissions" | "default";
export type CoachScope = "bugfix" | "feature-add" | "refactor" | "audit-and-fix" | "migration" | "research-and-implement" | "polish-and-verify";
export type ChecklistLevel = "blocking" | "warning" | "info";
export type ChecklistRemediation = "provider:anthropic" | "provider:cursor" | "git:dirty" | "git:branch" | "env:missing" | "port:busy" | "none";
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
    permissionMode: CoachPermMode;
}
export interface CoachResult {
    improvedObjective: string;
    scope: CoachScope;
    recommended: CoachRecommended;
    checklist: ChecklistItem[];
    rationale: string;
}
export declare function resolveCoachSkillPath(): string | null;
export declare function validateCoachOutput(raw: unknown): CoachResult | null;
export interface CoachContext {
    providers: ProviderConfig[];
    cliFlags: Record<string, string>;
    log?: PlannerLog;
    coachModel?: string;
    coachProvider?: ProviderConfig;
}
export declare function runSetupCoach(rawObjective: string, cwd: string, ctx: CoachContext): Promise<CoachResult | null>;
