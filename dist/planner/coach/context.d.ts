import type { ProviderConfig } from "../../providers/index.js";
export declare const URL_REGEX: RegExp;
export declare function fetchUrlContent(url: string, timeoutMs?: number): Promise<string | null>;
export interface RepoFacts {
    cwd: string;
    readmeHead: string;
    packageJson: {
        name?: string;
        scripts?: Record<string, string>;
        depSummary?: string;
    } | null;
    gitStatus: string;
    gitBranch: string;
    gitLog: string;
    tree: string[];
    hasEnv: boolean;
    hasTests: boolean;
    lockfiles: string[];
    priorRuns: number;
    srcFileCount: number;
}
export declare function collectRepoFacts(cwd: string): RepoFacts;
export declare function renderRepoFacts(f: RepoFacts, rawObjective: string, providers: ProviderConfig[], cliFlags: Record<string, string>, planContent: string | null): string;
