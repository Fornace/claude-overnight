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
export declare const COACH_SCHEMA: {
    type: "json_schema";
    schema: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            scope: {
                type: string;
                enum: string[];
            };
            improvedObjective: {
                type: string;
            };
            rationale: {
                type: string;
            };
            recommended: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    budget: {
                        type: string;
                        minimum: number;
                    };
                    concurrency: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    plannerModel: {
                        type: string;
                    };
                    workerModel: {
                        type: string;
                    };
                    fastModel: {
                        type: string[];
                    };
                    flex: {
                        type: string;
                    };
                    usageCap: {
                        type: string[];
                    };
                    permissionMode: {
                        type: string;
                        enum: string[];
                    };
                };
            };
            checklist: {
                type: string;
                items: {
                    type: string;
                    additionalProperties: boolean;
                    required: string[];
                    properties: {
                        id: {
                            type: string;
                        };
                        level: {
                            type: string;
                            enum: string[];
                        };
                        title: {
                            type: string;
                        };
                        detail: {
                            type: string;
                        };
                        remediation: {
                            type: string;
                            enum: string[];
                        };
                    };
                };
            };
            questions: {
                type: string;
                items: {
                    type: string;
                };
            };
        };
    };
};
export declare function validateCoachOutput(raw: unknown): CoachResult | null;
