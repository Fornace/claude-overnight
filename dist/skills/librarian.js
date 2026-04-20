import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, appendFileSync, } from "node:fs";
import { join } from "node:path";
import { openSkillsDb } from "./index-db.js";
import { renderPrompt } from "../prompts/load.js";
import { skillsRoot, canonDir, quarantineDir, candidatesDir, recipeDir } from "./paths.js";
const BODY_MAX = 15_360;
const CANDIDATE_CAP = 50;
const LIBRARIAN_TIMEOUT_MS = 60_000;
/** Validate a recipe body has exactly one fenced code block of the declared language. */
export function validateRecipeBody(body, language) {
    const pattern = new RegExp(`^\`\`\`${language}(?:\\s.*?)?$`, "gm");
    const matches = body.match(pattern);
    if (!matches || matches.length === 0) {
        return { valid: false, reason: `no code block found for language "${language}"` };
    }
    if (matches.length > 1) {
        return { valid: false, reason: `expected exactly one code block, found ${matches.length}` };
    }
    return { valid: true };
}
/** End-of-wave librarian pass. Time-boxed; on timeout, logs and returns. */
export async function runLibrarian(input) {
    const started = Date.now();
    const result = { promoted: 0, patched: 0, quarantined: 0, rejected: 0, elapsedMs: 0 };
    try {
        const fp = input.fingerprint;
        const canonMeta = loadCanonMeta(fp);
        const candidates = loadCandidates(fp);
        if (candidates.length === 0)
            return { ...result, elapsedMs: Date.now() - started };
        const abOutcomes = loadAbOutcomes(input.runId);
        const subagentInput = buildSubagentInput(canonMeta, candidates, abOutcomes);
        const actions = await callLibrarianSubagent(input, subagentInput);
        if (!actions)
            return { ...result, elapsedMs: Date.now() - started };
        applyActions(fp, actions, input.runId, input.wave, result);
        archiveCandidates(fp, input.runId);
        appendLibrarianLog(input.runId, input.wave, actions);
    }
    catch (err) {
        // Log but never abort the wave
        process.stderr.write(`[librarian] error: ${String(err)}\n`);
    }
    result.elapsedMs = Date.now() - started;
    return result;
}
function loadCanonMeta(fp) {
    const db = openSkillsDb();
    return db.prepare("SELECT name, description, version, uses, wins, losses, last_used_at, quarantined FROM skills WHERE repo_fingerprint = ?").all(fp);
}
function loadCandidates(fp) {
    const dir = candidatesDir(fp);
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().slice(0, CANDIDATE_CAP);
    const results = [];
    for (const f of files) {
        try {
            const text = readFileSync(join(dir, f), "utf-8");
            const kind = extractFrontmatterField(text, "kind") || "skill";
            const proposedBy = extractFrontmatterField(text, "proposed_by") || "unknown";
            const waveRaw = extractFrontmatterField(text, "wave") || "0";
            const trigger = extractFrontmatterField(text, "trigger") || "";
            const body = text.split(/^---\s*$/m, 2).pop()?.trim() ?? "";
            results.push({ candidate_file: f, kind, proposed_by: proposedBy, wave: parseInt(waveRaw, 10) || 0, trigger, body });
        }
        catch { /* skip corrupt files */ }
    }
    return results;
}
function loadAbOutcomes(runId) {
    const db = openSkillsDb();
    return db.prepare(`
    SELECT skill_name, COUNT(*) as trials,
      SUM(CASE WHEN event='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN event='loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN event='tie' THEN 1 ELSE 0 END) as ties,
      COALESCE(SUM(CASE WHEN event='cost_saved' THEN value ELSE 0 END), 0) as cost_saved_usd
    FROM skill_events WHERE run_id = ? GROUP BY skill_name
  `).all(runId);
}
function buildSubagentInput(canon, candidates, abOutcomes) {
    return JSON.stringify({ canon, candidates, ab_outcomes: abOutcomes });
}
// ── Subagent call ──
async function callLibrarianSubagent(input, data) {
    const env = input.envForModel?.(input.model);
    const prompt = renderPrompt("40_skills/40-3_librarian-wrap", { vars: { data } });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; }, LIBRARIAN_TIMEOUT_MS);
    try {
        const pq = query({
            prompt,
            options: {
                cwd: input.cwd,
                model: input.model,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                maxTurns: 8,
                ...(env && { env }),
            },
        });
        let resultText = "";
        for await (const msg of pq) {
            if (timedOut) {
                pq.interrupt().catch(() => { });
                break;
            }
            if (msg.type === "result" && msg.subtype === "success") {
                resultText = msg.result || "";
            }
        }
        pq.close();
        if (timedOut) {
            process.stderr.write("[librarian] subagent timed out\n");
            return null;
        }
        // Parse JSON — try direct parse first, then strip markdown fences
        const cleaned = resultText.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1").trim();
        return JSON.parse(cleaned);
    }
    finally {
        clearTimeout(timer);
    }
}
// ── Action application ──
function applyActions(fp, actions, runId, wave, result) {
    const cDir = canonDir(fp);
    const qDir = quarantineDir(fp);
    for (const a of actions) {
        switch (a.action) {
            case "create": {
                const isRecipe = !!a.recipe_language;
                if (isRecipe) {
                    const validation = validateRecipeBody(a.body, a.recipe_language);
                    if (!validation.valid) {
                        process.stderr.write(`[librarian] recipe ${a.name} rejected: ${validation.reason}\n`);
                        result.rejected++;
                        break;
                    }
                }
                if (Buffer.byteLength(a.body, "utf-8") > BODY_MAX) {
                    process.stderr.write(`[librarian] create ${a.name} rejected: body ${Buffer.byteLength(a.body)} > ${BODY_MAX} bytes\n`);
                    continue;
                }
                const destDir = isRecipe ? recipeDir(fp) : cDir;
                const mdPath = join(destDir, `${a.name}.md`);
                if (existsSync(mdPath)) {
                    // Already exists — treat as patch instead
                    const existing = readFileSync(mdPath, "utf-8");
                    const fm = extractFrontmatter(existing);
                    const oldVersion = typeof fm.version === "number" ? fm.version : 1;
                    const newVersion = oldVersion + 1;
                    const updatedFm = { ...fm, version: newVersion, patched_at: new Date().toISOString() };
                    writeFileSync(mdPath, renderFrontmatter(updatedFm) + "\n" + a.body, "utf-8");
                    updateSkillRow(fp, a.name, a.description, newVersion, a.triggers, a.requires_tools ?? [], a.languages ?? [], a.toolsets ?? [], mdPath, a.body, runId, wave);
                    result.patched++;
                }
                else {
                    const now = new Date().toISOString();
                    const fm = {
                        name: a.name, description: a.description.slice(0, 120), version: 1,
                        applies_to: { repo_fingerprint: fp, languages: a.languages ?? ["*"], toolsets: a.toolsets ?? ["*"] },
                        requires_tools: a.requires_tools ?? [],
                        triggers: a.triggers.slice(0, 10),
                        references: [],
                        created_at: now, last_used_at: null,
                        telemetry: { uses: 0, wins: 0, losses: 0, cost_saved_usd: 0, last_wave: null },
                        source: { candidate_ids: [], promoted_by: "librarian", promoted_at: now, patched_at: null },
                        quarantined: false,
                    };
                    if (isRecipe) {
                        fm.recipe_language = a.recipe_language;
                        fm.tested_with = a.tested_with ?? [];
                    }
                    writeFileSync(mdPath, renderFrontmatter(fm) + "\n" + a.body, "utf-8");
                    insertSkillRow(fp, a.name, a.description, a.triggers, a.requires_tools ?? [], a.languages ?? ["*"], a.toolsets ?? ["*"], mdPath, a.body, now, isRecipe ? "tool-recipe" : "skill");
                    result.promoted++;
                }
                break;
            }
            case "patch": {
                const mdPath = join(cDir, `${a.name}.md`);
                if (!existsSync(mdPath))
                    continue;
                const existing = readFileSync(mdPath, "utf-8");
                if (Buffer.byteLength(a.patch_body, "utf-8") > BODY_MAX)
                    continue;
                const fm = extractFrontmatter(existing);
                const oldVersion = typeof fm.version === "number" ? fm.version : 1;
                const newVersion = oldVersion + 1;
                const updatedFm = { ...fm, version: newVersion, patched_at: new Date().toISOString() };
                if (a.description)
                    updatedFm.description = a.description.slice(0, 120);
                writeFileSync(mdPath, renderFrontmatter(updatedFm) + "\n" + a.patch_body, "utf-8");
                const db = openSkillsDb();
                const newDesc = (a.description || (typeof fm.description === "string" ? fm.description : ""));
                db.prepare("UPDATE skills SET version = ?, description = ? WHERE name = ?").run(newVersion, newDesc, a.name);
                result.patched++;
                break;
            }
            case "quarantine": {
                const src = join(cDir, `${a.name}.md`);
                const dest = join(qDir, `${a.name}.md`);
                if (existsSync(src))
                    renameSync(src, dest);
                const db = openSkillsDb();
                db.prepare("UPDATE skills SET quarantined = 1 WHERE name = ?").run(a.name);
                result.quarantined++;
                break;
            }
            case "reject_candidate": {
                result.rejected++;
                break;
            }
        }
    }
}
// ── Candidate archival ──
function archiveCandidates(fp, runId) {
    const srcDir = candidatesDir(fp);
    if (!existsSync(srcDir))
        return;
    const files = readdirSync(srcDir).filter(f => f.endsWith(".md"));
    if (files.length === 0)
        return;
    const destDir = join(skillsRoot(), fp, "processed", runId);
    mkdirSync(destDir, { recursive: true });
    for (const f of files) {
        try {
            renameSync(join(srcDir, f), join(destDir, f));
        }
        catch { }
    }
}
// ── LIBRARIAN.md log ──
function appendLibrarianLog(runId, wave, actions) {
    const logPath = join(skillsRoot(), "LIBRARIAN.md");
    const header = `### ${new Date().toISOString()} · ${runId} · wave ${wave}`;
    const lines = [header];
    for (const a of actions) {
        switch (a.action) {
            case "create":
                lines.push(`- promote  ${a.name.padEnd(35)} — created`);
                break;
            case "patch":
                lines.push(`- patch    ${a.name.padEnd(35)} — ${a.description || "body update"}`);
                break;
            case "quarantine":
                lines.push(`- quarantine ${a.name.padEnd(33)} — ${a.reason}`);
                break;
            case "reject_candidate":
                lines.push(`- reject   ${a.candidate_file.padEnd(35)} — ${a.reason}`);
                break;
        }
    }
    lines.push("");
    appendFileSync(logPath, lines.join("\n") + "\n", "utf-8");
}
// ── DB helpers ──
function insertSkillRow(fp, name, desc, triggers, requiresTools, languages, toolsets, bodyPath, body, createdAt, kind) {
    const db = openSkillsDb();
    db.prepare(`
    INSERT INTO skills(name, repo_fingerprint, description, version, languages, toolsets, requires_tools, triggers, body_path, size_bytes, created_at, kind)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, fp, desc, JSON.stringify(languages), JSON.stringify(toolsets), JSON.stringify(requiresTools), JSON.stringify(triggers), bodyPath, Buffer.byteLength(body, "utf-8"), createdAt, kind);
}
function updateSkillRow(_fp, name, desc, version, triggers, requiresTools, languages, toolsets, bodyPath, body, _runId, _wave) {
    const db = openSkillsDb();
    db.prepare(`
    UPDATE skills SET description = COALESCE(?, description), version = ?, triggers = ?, requires_tools = ?, languages = ?, toolsets = ?, body_path = ?, size_bytes = ?
    WHERE name = ?
  `).run(desc ?? null, version, JSON.stringify(triggers), JSON.stringify(requiresTools), JSON.stringify(languages), JSON.stringify(toolsets), bodyPath, Buffer.byteLength(body, "utf-8"), name);
}
// ── Frontmatter utilities ──
function extractFrontmatterField(text, field) {
    const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
    return m ? m[1].replace(/^"|"$/g, "").trim() : "";
}
function extractFrontmatter(text) {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m)
        return {};
    const fm = {};
    for (const line of m[1].split("\n")) {
        const eq = line.indexOf(":");
        if (eq < 0)
            continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // Try parse as JSON for arrays/objects/numbers
        try {
            fm[key] = JSON.parse(val);
        }
        catch {
            if (val === "null")
                fm[key] = null;
            else if (val === "true")
                fm[key] = true;
            else if (val === "false")
                fm[key] = false;
            else
                fm[key] = val.replace(/^"|"$/g, "");
        }
    }
    return fm;
}
function renderFrontmatter(obj) {
    const lines = ["---"];
    for (const [key, val] of Object.entries(obj)) {
        if (val === undefined || val === null)
            continue;
        const v = typeof val === "string" ? `"${val}"` : typeof val === "object" ? JSON.stringify(val) : String(val);
        lines.push(`${key}: ${v}`);
    }
    lines.push("---");
    return lines.join("\n");
}
