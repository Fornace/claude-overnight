import { chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readJsonOrNull, writeJson } from "../../core/fs-helpers.js";

const SETTINGS_PATH = join(homedir(), ".claude", "claude-overnight", "settings.json");

export interface UserSettings {
  skipCoach?: boolean;
  lastCoachedAt?: number;
  coachModel?: string;
  coachProviderId?: string;
}

export function loadUserSettings(): UserSettings {
  return readJsonOrNull<UserSettings>(SETTINGS_PATH) ?? {};
}

export function saveUserSettings(s: UserSettings): void {
  try {
    writeJson(SETTINGS_PATH, s);
    try { chmodSync(SETTINGS_PATH, 0o600); } catch {}
  } catch {}
}
