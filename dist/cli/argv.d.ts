export declare function parseCliFlags(argv: string[]): {
    flags: Record<string, string>;
    positional: string[];
};
export declare function validateConcurrency(value: unknown): asserts value is number;
export declare function isGitRepo(cwd: string): boolean;
export declare function validateGitRepo(cwd: string): void;
