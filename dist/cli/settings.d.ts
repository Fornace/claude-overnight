import type { MutableRunSettings, PermMode } from "../core/types.js";
interface EditSettingsOptions {
    /** Existing settings to show as current values (resume) or blank defaults. */
    current: MutableRunSettings;
    /** CLI flags that already override concurrency (skip prompt if set). */
    cliConcurrencySet?: boolean;
    /** Coach-recommended defaults (initial setup only). */
    defaults?: {
        plannerModel?: string;
        workerModel?: string;
        fastModel?: string;
        concurrency?: number;
        usageCap?: number | null;
        permissionMode?: PermMode;
    };
}
/** Interactively edit all mutable run settings. Mutates `options.current` in place. */
export declare function editRunSettings(options: EditSettingsOptions): Promise<MutableRunSettings>;
/** Format a MutableRunSettings as a compact summary line for the terminal. */
export declare function formatSettingsSummary(s: MutableRunSettings): string;
export {};
