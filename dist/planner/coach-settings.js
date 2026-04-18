import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
const SETTINGS_DIR = join(homedir(), ".claude", "claude-overnight");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
export function loadUserSettings() {
    try {
        return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveUserSettings(s) {
    try {
        mkdirSync(SETTINGS_DIR, { recursive: true });
        writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf-8");
        try {
            chmodSync(SETTINGS_PATH, 0o600);
        }
        catch { }
    }
    catch { }
}
