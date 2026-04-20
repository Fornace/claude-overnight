/** Build an L0 stub for injection into planner/agent prompts. */
export declare function buildL0Stub(opts: {
    fingerprint: string;
    role?: string;
    tools?: string[];
    excludeSkill?: string;
}): {
    text: string;
    count: number;
    remaining: number;
};
/** Build a recipe L0 stub — opt-in section for tool recipes. Returns null if no recipes match. */
export declare function buildRecipeStub(opts: {
    fingerprint: string;
    tools?: string[];
}): {
    text: string;
    count: number;
} | null;
