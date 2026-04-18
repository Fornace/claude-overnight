// The settings panel — fields the user can edit live with the [s] hotkey.
//
// `SETTINGS_FIELDS` is the canonical order; every other array (labels,
// numeric mask) keys off it. `readSettingValue` formats the current value for
// the "current: …" hint shown next to the input prompt; `applySettingEdit`
// commits a typed value back into liveConfig + swarm.

import type { Swarm } from "../swarm/swarm.js";
import type { LiveConfig } from "./types.js";

export const SETTINGS_FIELDS = [
  "budget", "cap", "conc", "extra", "worker", "planner", "fast", "pause",
] as const;
export type SettingsField = typeof SETTINGS_FIELDS[number];

export const NUMERIC_SETTINGS_FIELDS = new Set<SettingsField>([
  "budget", "cap", "conc", "extra",
]);

/** Human-readable prompts shown to the user, parallel to `SETTINGS_FIELDS`. */
export const SETTINGS_LABELS: Record<SettingsField, string> = {
  budget: "New budget (remaining sessions)",
  cap: "New usage cap (0-100%, 0=unlimited)",
  conc: "New concurrency (min 1)",
  extra: "Extra usage $ cap (0=stop on overage)",
  worker: "Worker model (for agent tasks)",
  planner: "Planner model (steering/thinking)",
  fast: "Fast model (optional, empty=skip)",
  pause: "Pause/resume workers",
};

/** Format the current value of `field` for display in the settings prompt. */
export function readSettingValue(field: SettingsField, lc: LiveConfig | undefined, swarm: Swarm | undefined): string {
  switch (field) {
    case "budget": return String(lc?.remaining ?? "—");
    case "cap": return lc?.usageCap != null ? `${Math.round(lc.usageCap * 100)}%` : "unlimited";
    case "conc": return String(lc?.concurrency ?? "—");
    case "extra": return lc?.extraUsageBudget != null ? `$${lc.extraUsageBudget}` : "unlimited";
    case "worker": return lc?.workerModel ?? swarm?.model ?? "—";
    case "planner": return lc?.plannerModel ?? "—";
    case "fast": return lc?.fastModel ?? "(none)";
    case "pause": return swarm?.paused ? "paused" : "running";
  }
}

/** Commit a typed edit for `field`. Mutates `lc` and (when relevant) `swarm`.
 *  Empty / invalid input for numeric fields is silently dropped. `pause` toggles
 *  regardless of input — the prompt for that field is just a confirmation step. */
export function applySettingEdit(
  field: SettingsField,
  raw: string,
  lc: LiveConfig,
  swarm: Swarm | undefined,
): void {
  switch (field) {
    case "budget": {
      const v = parseFloat(raw);
      if (!isNaN(v) && v > 0) {
        lc.remaining = Math.round(v);
        lc.dirty = true;
        swarm?.log(-1, `Budget changed to ${lc.remaining} remaining`);
      }
      return;
    }
    case "cap": {
      const v = parseFloat(raw);
      if (!isNaN(v) && v >= 0 && v <= 100) {
        const frac = v / 100;
        lc.usageCap = frac > 0 ? frac : undefined;
        lc.dirty = true;
        if (swarm) swarm.usageCap = lc.usageCap;
        swarm?.log(-1, `Usage cap changed to ${v > 0 ? v + "%" : "unlimited"}`);
      }
      return;
    }
    case "conc": {
      const v = parseFloat(raw);
      if (!isNaN(v) && v >= 1) {
        const n = Math.round(v);
        lc.concurrency = n;
        lc.dirty = true;
        swarm?.setConcurrency(n);
      }
      return;
    }
    case "extra": {
      const v = parseFloat(raw);
      if (!isNaN(v) && v >= 0) {
        lc.extraUsageBudget = v;
        lc.dirty = true;
        swarm?.setExtraUsageBudget(v);
      }
      return;
    }
    case "worker": {
      if (!raw) return;
      lc.workerModel = raw;
      lc.dirty = true;
      swarm?.setModel(raw);
      return;
    }
    case "planner": {
      if (!raw) return;
      lc.plannerModel = raw;
      lc.dirty = true;
      return;
    }
    case "fast": {
      lc.fastModel = raw || undefined;
      lc.dirty = true;
      return;
    }
    case "pause": {
      if (!swarm) return;
      const next = !swarm.paused;
      swarm.setPaused(next);
      lc.paused = next;
      lc.dirty = true;
      return;
    }
  }
}
