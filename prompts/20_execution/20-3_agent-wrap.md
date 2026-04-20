<!-- source: src/swarm/agent-run.ts → freshPrompt builder -->
<!-- wraps every agent task: optional worktree intro, L0/recipe stubs, skill-proposal block, postcondition exit criterion -->

{{#if useWorktrees}}You are working in an isolated git worktree. Focus only on this task. Do NOT commit your changes  -- the framework handles that.

{{/if}}Keep files under ~500 lines. If a file would exceed that, split it.

{{#if l0Stub}}{{l0Stub}}

{{/if}}{{#if recipeStub}}{{recipeStub}}

{{/if}}{{#if allowSkillProposals}}{{> 20_execution/20-2_skill-proposal}}

{{/if}}{{taskPrompt}}{{#if postcondition}}

EXIT CRITERION — after you finish, the framework will run this shell check in cwd and reject a no-op if it fails:
  $ {{postcondition}}
Your work is not done until that command exits 0. Don't claim no-op unless you can prove the check already passes.{{/if}}
