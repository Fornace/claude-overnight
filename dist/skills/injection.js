import { queryCandidateL0, queryRecipeL0 } from "./index-db.js";
const TOKEN_BUDGET = 2048;
const RECIPE_TOKEN_BUDGET = 512;
const CHARS_PER_TOKEN = 4;
/** Render bullet list of `- \`name\` — desc` items, capped by char budget. */
function renderBullets(items, header, tokenBudget) {
    const maxChars = tokenBudget * CHARS_PER_TOKEN;
    const lines = [...header];
    let charCount = lines.join("\n").length;
    let count = 0;
    for (const it of items) {
        const line = `- \`${it.name}\` — ${it.description}`;
        if (charCount + line.length + 1 > maxChars)
            break;
        lines.push(line);
        charCount += line.length + 1;
        count++;
    }
    const remaining = items.length - count;
    if (remaining > 0) {
        lines.push(`…plus ${remaining} more — use \`skill_search(query)\` to find them.`);
    }
    lines.push("");
    return { text: lines.join("\n"), count, remaining };
}
/** Build an L0 stub for injection into planner/agent prompts. */
export function buildL0Stub(opts) {
    const all = queryCandidateL0(opts.fingerprint, { availableTools: opts.tools });
    const skills = opts.excludeSkill ? all.filter(s => s.name !== opts.excludeSkill) : all;
    if (skills.length === 0)
        return { text: "", count: 0, remaining: 0 };
    return renderBullets(skills, [
        "## Skills available (L0 stub)",
        "",
        `You have ${skills.length} project-specific skills available. Call \`skill_read(name)\` to load the full body on demand. Do not assume a skill matches — read it first.`,
        "",
    ], TOKEN_BUDGET);
}
/** Build a recipe L0 stub — opt-in section for tool recipes. Returns null if no recipes match. */
export function buildRecipeStub(opts) {
    const recipes = queryRecipeL0(opts.fingerprint, { availableTools: opts.tools });
    if (recipes.length === 0)
        return null;
    const result = renderBullets(recipes, ["## Helpers you've written before (recipes)", ""], RECIPE_TOKEN_BUDGET);
    if (result.count === 0)
        return null;
    return { text: result.text, count: result.count };
}
