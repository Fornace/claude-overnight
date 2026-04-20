import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRecipeBody } from "../skills/librarian.js";

// ── validateRecipeBody ──

describe("validateRecipeBody", () => {
  it("accepts a valid recipe with exactly one code block", () => {
    const body = `## When to apply
Use when running a single test file.

\`\`\`bash
npm test -- --testPathPattern=foo.test.ts --reporters=silent
\`\`\`

## Caveats
Only works with npm workspaces.`;
    const result = validateRecipeBody(body, "bash");
    assert.equal(result.valid, true);
  });

  it("rejects a recipe with zero code blocks", () => {
    const body = `## When to apply
Always.

## Steps
Just do it.`;
    const result = validateRecipeBody(body, "bash");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("no code block"));
  });

  it("rejects a recipe with multiple code blocks of the same language", () => {
    const body = `## Step 1

\`\`\`bash
echo "step 1"
\`\`\`

## Step 2

\`\`\`bash
echo "step 2"
\`\`\``;
    const result = validateRecipeBody(body, "bash");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("expected exactly one"));
  });

  it("accepts a code block with additional options after language tag", () => {
    const body = `Example:\n\n\`\`\`bash --no-sandbox\necho hello\n\`\`\``;
    const result = validateRecipeBody(body, "bash");
    assert.equal(result.valid, true);
  });

  it("is language-specific", () => {
    const body = `## Example\n\n\`\`\`typescript\nconst x = 1;\n\`\`\``;
    assert.equal(validateRecipeBody(body, "typescript").valid, true);
    assert.equal(validateRecipeBody(body, "javascript").valid, false);
  });
});
