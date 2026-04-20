export interface SkillReadResult {
    ok: boolean;
    body?: string;
    error?: string;
}
export interface SkillSearchResult {
    name: string;
    description: string;
}
/** Read a skill's full body. Enforces per-agent per-wave hydration cap. */
export declare function skillReadTool(name: string, fingerprint: string, runId: string, wave: number, agentId: number, reference?: string): SkillReadResult;
/** FTS5 search — returns names + descriptions only. */
export declare function skillSearchTool(query: string, fingerprint: string): SkillSearchResult[];
/** Reset hydration counters — test-only. */
export declare function resetHydrationCounts(): void;
