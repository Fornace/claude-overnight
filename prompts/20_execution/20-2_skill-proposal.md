<!-- source: src/swarm/config.ts → SKILL_PROPOSAL_PROMPT -->
<!-- appended to agent task prompts when allowSkillProposals is true -->

If you encounter a non-obvious workflow or repo-specific quirk that would save a future agent time, emit this block at the very end of your response:

### SKILL CANDIDATE
trigger: <one sentence>
body: <markdown, 2-5 short sections: when to apply, steps, caveats>

Same rule applies to helpers (shell one-liners, jq/sql/ts utilities): if you wrote something non-trivial that worked, mark the candidate `kind: tool-recipe`, `recipe_language: <lang>`, and include exactly one fenced code block.

Only emit when the signal is strong. Otherwise omit.
