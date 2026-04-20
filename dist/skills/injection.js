import { queryCandidateL0, queryRecipeL0 } from "./index-db.js";
const TOKEN_BUDGET = 2048;
const RECIPE_TOKEN_BUDGET = 512;
const CHARS_PER_TOKEN = 4;
/** Build an L0 stub for injection into planner/agent prompts. */
export function buildL0Stub(opts) {
    const all = queryCandidateL0(opts.fingerprint, { availableTools: opts.tools });
    const skills = opts.excludeSkill ? all.filter(s => s.name !== opts.excludeSkill) : all;
    if (skills.length === 0)
        return { text: "", count: 0, remaining: 0 };
    const lines = [
        "## Skills available (L0 stub)",
        "",
        `You have ${skills.length} project-specific skills available. Call \`skill_read(name)\` to load the full body on demand. Do not assume a skill matches — read it first.`,
        "",
    ];
    let charCount = lines.join("\n").length;
    const maxChars = TOKEN_BUDGET * CHARS_PER_TOKEN;
    let included = 0;
    for (const s of skills) {
        const line = `- \`${s.name}\` — ${s.description}`;
        if (charCount + line.length + 1 > maxChars)
            break; // +1 for newline
        lines.push(line);
        included++;
        charCount += line.length + 1;
    }
    const remaining = skills.length - included;
    if (remaining > 0) {
        lines.push(`…plus ${remaining} more — use \`skill_search(query)\` to find them.`);
    }
    lines.push("");
    return { text: lines.join("\n"), count: included, remaining };
}
/** Build a recipe L0 stub — opt-in section for tool recipes. Returns null if no recipes match. */
export function buildRecipeStub(opts) {
    const recipes = queryRecipeL0(opts.fingerprint, { availableTools: opts.tools });
    if (recipes.length === 0)
        return null;
    const lines = [
        "## Helpers you've written before (recipes)",
        "",
    ];
    let charCount = lines.join("\n").length;
    const maxChars = RECIPE_TOKEN_BUDGET * CHARS_PER_TOKEN;
    let included = 0;
    for (const r of recipes) {
        const line = `- \`${r.name}\` — ${r.description}`;
        if (charCount + line.length + 1 > maxChars)
            break;
        lines.push(line);
        included++;
        charCount += line.length + 1;
    }
    if (included === 0)
        return null;
    const remaining = recipes.length - included;
    if (remaining > 0) {
        lines.push(`…plus ${remaining} more — use \`skill_search(query)\` to find them.`);
    }
    lines.push("");
    return { text: lines.join("\n"), count: included };
}
