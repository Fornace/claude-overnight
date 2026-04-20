import type { Swarm } from "../swarm/swarm.js";
import type { LiveConfig } from "./types.js";
export declare const SETTINGS_FIELDS: readonly ["budget", "cap", "conc", "extra", "worker", "planner", "fast", "pause"];
export type SettingsField = typeof SETTINGS_FIELDS[number];
export declare const NUMERIC_SETTINGS_FIELDS: Set<"cap" | "extra" | "planner" | "budget" | "pause" | "fast" | "worker" | "conc">;
/** Human-readable prompts shown to the user, parallel to `SETTINGS_FIELDS`. */
export declare const SETTINGS_LABELS: Record<SettingsField, string>;
/** Format the current value of `field` for display in the settings prompt. */
export declare function readSettingValue(field: SettingsField, lc: LiveConfig | undefined, swarm: Swarm | undefined): string;
/** Commit a typed edit for `field`. Mutates `lc` and (when relevant) `swarm`.
 *  Empty / invalid input for numeric fields is silently dropped. `pause` toggles
 *  regardless of input — the prompt for that field is just a confirmation step. */
export declare function applySettingEdit(field: SettingsField, raw: string, lc: LiveConfig, swarm: Swarm | undefined): void;
