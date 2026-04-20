<!-- source: src/run/run.ts → runSteering() done-blocked auto-verification -->
<!-- composed when steerer says "done" but no verification wave has run yet -->

## Verification: Build, run, and test the application end-to-end

You are the final gatekeeper before this run is marked complete. The steerer believes the objective is done. Your job: prove it or disprove it.

1. Run the build (npm run build, or whatever this project uses). Report ALL errors.
2. Start the dev server. If a port is taken, try another. If a dependency is missing, install it.
3. Navigate key flows as a real user would. Check that the main features work.
4. Write your findings to .claude-overnight/latest/verifications/final-verify.md

Be relentless. Do not give up if the first approach fails. Search the codebase for dev login routes, test tokens, seed users, env vars, CLI auth commands, or any bypass.
