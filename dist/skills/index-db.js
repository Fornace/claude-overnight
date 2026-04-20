import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { skillsRoot, indexPath } from "./paths.js";
let _db;
/** Open (or create + migrate) the skills index. Idempotent. */
export function openSkillsDb() {
    if (_db)
        return _db;
    mkdirSync(skillsRoot(), { recursive: true });
    _db = new Database(indexPath());
    _db.pragma("journal_mode = WAL");
    _db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      repo_fingerprint TEXT NOT NULL,
      description TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      languages TEXT NOT NULL,
      toolsets TEXT NOT NULL,
      requires_tools TEXT NOT NULL,
      triggers TEXT NOT NULL,
      body_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      cost_saved_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      last_wave INTEGER,
      quarantined INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS skills_by_fp  ON skills(repo_fingerprint);
    CREATE INDEX IF NOT EXISTS skills_by_quar ON skills(quarantined);
    CREATE INDEX IF NOT EXISTS skills_by_last_used ON skills(last_used_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
      name, description, triggers, body
    );

    CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
      INSERT INTO skills_fts(name, description, triggers, body)
      VALUES (new.name, new.description, new.triggers, '');
    END;
    CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
      DELETE FROM skills_fts WHERE name = old.name;
    END;
    CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
      DELETE FROM skills_fts WHERE name = old.name;
      INSERT INTO skills_fts(name, description, triggers, body)
      VALUES (new.name, new.description, new.triggers, '');
    END;

    CREATE TABLE IF NOT EXISTS skill_events (
      ts TEXT NOT NULL,
      run_id TEXT NOT NULL,
      wave INTEGER NOT NULL,
      skill_name TEXT NOT NULL,
      event TEXT NOT NULL,
      value REAL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS events_by_skill ON skill_events(skill_name);
    CREATE INDEX IF NOT EXISTS events_by_run   ON skill_events(run_id);
  `);
    // Phase 3 A/B waves: lazy-add columns if missing
    try {
        _db.exec("ALTER TABLE skills ADD COLUMN ab_eligible INTEGER NOT NULL DEFAULT 0");
    }
    catch { }
    try {
        _db.exec("ALTER TABLE skills ADD COLUMN ab_last_trial_run TEXT");
    }
    catch { }
    // Phase 4 tool recipes: kind column to distinguish skills from recipes
    try {
        _db.exec("ALTER TABLE skills ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill'");
    }
    catch { }
    return _db;
}
/** Return candidates for a fingerprint that match the agent's available tools. */
export function queryCandidateL0(fp, ctx) {
    const db = openSkillsDb();
    const rows = db.prepare(`
    SELECT * FROM skills
    WHERE repo_fingerprint = ? AND quarantined = 0 AND kind = 'skill'
    ORDER BY CAST(wins AS REAL) / NULLIF(uses, 0) DESC, last_used_at DESC
    LIMIT 30
  `).all(fp);
    if (!ctx.availableTools || ctx.availableTools.length === 0)
        return rows;
    // Filter out skills whose requires_tools aren't all satisfied.
    return rows.filter((r) => {
        const reqs = JSON.parse(r.requires_tools);
        return reqs.every((t) => ctx.availableTools.includes(t));
    });
}
/** Return recipes for a fingerprint that match the agent's available tools. */
export function queryRecipeL0(fp, ctx) {
    const db = openSkillsDb();
    const rows = db.prepare(`
    SELECT * FROM skills
    WHERE repo_fingerprint = ? AND quarantined = 0 AND kind = 'tool-recipe'
    ORDER BY CAST(wins AS REAL) / NULLIF(uses, 0) DESC, last_used_at DESC
    LIMIT 20
  `).all(fp);
    if (!ctx.availableTools || ctx.availableTools.length === 0)
        return rows;
    return rows.filter((r) => {
        const reqs = JSON.parse(r.requires_tools);
        return reqs.every((t) => ctx.availableTools.includes(t));
    });
}
/** Append a telemetry event. */
export function recordEvent(runId, wave, skill, event, value, notes) {
    const db = openSkillsDb();
    db.prepare("INSERT INTO skill_events(ts, run_id, wave, skill_name, event, value, notes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(new Date().toISOString(), runId, wave, skill, event, value ?? null, notes ?? null);
}
/** Increment use counter and refresh last_used_at. */
export function incrementUse(skillName) {
    const db = openSkillsDb();
    db.prepare("UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE name = ?").run(new Date().toISOString(), skillName);
}
/** Return skills eligible for A/B testing for this fingerprint. */
export function queryAbEligibleSkills(fp) {
    const db = openSkillsDb();
    return db.prepare("SELECT * FROM skills WHERE repo_fingerprint = ? AND quarantined = 0 AND ab_eligible = 1 ORDER BY uses ASC LIMIT 5").all(fp);
}
/** Mark a skill's last A/B trial timestamp. */
export function markAbTrial(skillName) {
    const db = openSkillsDb();
    db.prepare("UPDATE skills SET ab_last_trial_run = ? WHERE name = ?").run(new Date().toISOString(), skillName);
}
/** Reset the in-memory handle (useful for tests). */
export function resetDb() {
    _db?.close();
    _db = undefined;
}
