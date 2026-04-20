import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSkillsDb, incrementUse, recordEvent } from "./index-db.js";
import { skillsRoot } from "./paths.js";
const HYDRATION_CAP = 5;
const hydrationCounts = new Map(); // key: `${runId}:${wave}:${agentId}`
/** Get the hydration counter key for an agent in a wave. */
function hydrKey(runId, wave, agentId) {
    return `${runId}:${wave}:${agentId}`;
}
/** Read a skill's full body. Enforces per-agent per-wave hydration cap. */
export function skillReadTool(name, fingerprint, runId, wave, agentId, reference) {
    const key = hydrKey(runId, wave, agentId);
    const count = hydrationCounts.get(key) ?? 0;
    if (count >= HYDRATION_CAP) {
        return { ok: false, error: "hydration cap reached; use skill_search to refine" };
    }
    const db = openSkillsDb();
    const row = db.prepare("SELECT * FROM skills WHERE name = ? AND repo_fingerprint = ? AND quarantined = 0").get(name, fingerprint);
    if (!row)
        return { ok: false, error: `skill '${name}' not found` };
    // Read body from disk
    const bodyPath = join(skillsRoot(), row.body_path);
    let body;
    try {
        body = readFileSync(bodyPath, "utf-8");
    }
    catch {
        recordEvent(runId, wave, name, "read_miss", undefined, `file not found: ${bodyPath}`);
        return { ok: false, error: `skill file not found for '${name}'` };
    }
    // Record hydration
    incrementUse(name);
    recordEvent(runId, wave, name, "hydrated");
    hydrationCounts.set(key, count + 1);
    void reference; // L2 references not yet implemented
    return { ok: true, body };
}
/** FTS5 search — returns names + descriptions only. */
export function skillSearchTool(query, fingerprint) {
    const db = openSkillsDb();
    const rows = db.prepare(`
    SELECT name, description FROM skills_fts
    WHERE skills_fts MATCH ?
    LIMIT 5
  `).all(query);
    // Filter to current fingerprint
    const fpNames = new Set(db.prepare("SELECT name FROM skills WHERE repo_fingerprint = ? AND quarantined = 0").all(fingerprint).map((r) => r.name));
    return rows.filter(r => fpNames.has(r.name));
}
/** Reset hydration counters — test-only. */
export function resetHydrationCounts() {
    hydrationCounts.clear();
}
