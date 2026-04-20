/** Test-only: redirect skillsRoot to a temp dir. */
export declare function __setRoot(dir: string): void;
/** Test-only: restore the real root. */
export declare function __restoreRoot(): void;
export declare function skillsRoot(): string;
export declare function fingerprintDir(fp: string): string;
export declare function candidatesDir(fp: string): string;
export declare function canonDir(fp: string): string;
export declare function recipeDir(fp: string): string;
export declare function quarantineDir(fp: string): string;
export declare function indexPath(): string;
