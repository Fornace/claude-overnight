import { type PlannerLog } from "../query.js";
import type { ProviderConfig } from "../../providers/index.js";
import { type CoachResult } from "./schema.js";
export { loadUserSettings, saveUserSettings, type UserSettings } from "./settings.js";
export { validateCoachOutput, type CoachResult, type CoachPermMode, type CoachScope, type ChecklistLevel, type ChecklistRemediation, type ChecklistItem, type CoachRecommended, } from "./schema.js";
export declare const COACH_MODEL = "claude-haiku-4-5";
export declare function resolveCoachSkillPath(): string | null;
export interface CoachContext {
    providers: ProviderConfig[];
    cliFlags: Record<string, string>;
    log?: PlannerLog;
    coachModel?: string;
    coachProvider?: ProviderConfig;
}
export declare function runSetupCoach(rawObjective: string, cwd: string, ctx: CoachContext): Promise<CoachResult | null>;
