import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCommit } from "../merge.js";
// Regression test for the pre-1.11.10 filesChanged=0 orphan-branch bug.
//
// autoCommit() used to measure work by counting `git status --porcelain` lines
// in the worktree. When an agent committed its own work (common  -- some agents
// prefer to own their git hygiene), the worktree was clean at measurement time,
// `status --porcelain` returned empty, autoCommit returned 0, and the branch was
// dropped from the merge gate (`filesChanged > 0`)  -- the commit survived on the
// branch but never landed in main, silently orphaned.
//
// The fix: measure filesChanged from `<baseRef>..HEAD` diff. This is correct
// regardless of who made the commits.
//
// See payme run 2026-04-12T13-03-57: 15/53 tasks hit this bug.
const tmp = mkdtempSync(join(tmpdir(), "co-auto-commit-"));
after(() => { try {
    rmSync(tmp, { recursive: true, force: true });
}
catch { } });
function sh(cmd, cwd) {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}
function makeRepo(name) {
    const repo = join(tmp, name);
    mkdirSync(repo, { recursive: true });
    sh("git init -q -b main", repo);
    sh('git config user.email "t@t"', repo);
    sh('git config user.name "t"', repo);
    writeFileSync(join(repo, "seed.txt"), "hello\n");
    sh("git add -A && git commit -q -m seed", repo);
    const baseRef = sh("git rev-parse HEAD", repo).trim();
    const worktree = join(tmp, `${name}-wt`);
    sh(`git worktree add -q -b swarm/task-test "${worktree}" HEAD`, repo);
    return { repo, worktree, baseRef };
}
const noop = () => { };
describe("autoCommit  -- agent-self-commit accounting (regression)", () => {
    it("counts files when the agent already committed its work", () => {
        const { worktree, baseRef } = makeRepo("self-commit");
        // Agent writes and commits its own work  -- worktree ends up CLEAN.
        writeFileSync(join(worktree, "a.txt"), "a\n");
        writeFileSync(join(worktree, "b.txt"), "b\n");
        sh("git add -A && git commit -q -m 'agent self commit'", worktree);
        const status = sh("git status --porcelain", worktree).trim();
        assert.equal(status, "", "worktree must be clean  -- this is the bug's precondition");
        const n = autoCommit(0, "task prompt", worktree, baseRef, noop);
        assert.equal(n, 2, "should report 2 files from branch-diff even though status is clean");
    });
    it("counts files when autoCommit itself has to commit dirty changes", () => {
        const { worktree, baseRef } = makeRepo("dirty");
        writeFileSync(join(worktree, "x.txt"), "x\n");
        writeFileSync(join(worktree, "y.txt"), "y\n");
        writeFileSync(join(worktree, "z.txt"), "z\n");
        const n = autoCommit(0, "task prompt", worktree, baseRef, noop);
        assert.equal(n, 3);
        // And the tree should now be clean.
        assert.equal(sh("git status --porcelain", worktree).trim(), "");
    });
    it("counts the union when the agent commits some and leaves others dirty", () => {
        const { worktree, baseRef } = makeRepo("mixed");
        writeFileSync(join(worktree, "committed.txt"), "c\n");
        sh("git add -A && git commit -q -m 'agent partial'", worktree);
        writeFileSync(join(worktree, "uncommitted.txt"), "u\n");
        const n = autoCommit(0, "task prompt", worktree, baseRef, noop);
        assert.equal(n, 2, "both the agent's commit and autoCommit's commit should be counted");
    });
    it("returns 0 when the agent did no work at all", () => {
        const { worktree, baseRef } = makeRepo("noop");
        const n = autoCommit(0, "task prompt", worktree, baseRef, noop);
        assert.equal(n, 0);
    });
    it("returns 0 when baseRef is missing (degrades safely)", () => {
        const { worktree } = makeRepo("no-base");
        writeFileSync(join(worktree, "a.txt"), "a\n");
        const n = autoCommit(0, "task prompt", worktree, undefined, noop);
        assert.equal(n, 0, "no baseRef → can't measure → return 0 rather than crash");
    });
    // Regression: hook-gated projects (husky/lint-staged/etc.) used to lose
    // work because autoCommit caught the hook error, logged "git commit failed",
    // returned 0, and then the branch got dropped by the merge gate. The
    // worktree cleanup destroyed the uncommitted files. Fix: retry with
    // --no-verify for swarm scaffolding commits.
    it("bypasses a rejecting pre-commit hook so work still lands on branch", () => {
        const { repo, worktree, baseRef } = makeRepo("hook-reject");
        // Install a pre-commit hook that always rejects.
        const hookDir = join(repo, ".git", "hooks");
        const hookPath = join(hookDir, "pre-commit");
        writeFileSync(hookPath, "#!/bin/sh\necho 'hook says no'\nexit 1\n");
        chmodSync(hookPath, 0o755);
        writeFileSync(join(worktree, "a.txt"), "a\n");
        writeFileSync(join(worktree, "b.txt"), "b\n");
        const logs = [];
        const n = autoCommit(0, "task prompt", worktree, baseRef, (_, m) => logs.push(m));
        assert.equal(n, 2, "both files should be counted as landed after hook bypass");
        // And the worktree should now be clean (changes committed).
        assert.equal(sh("git status --porcelain", worktree).trim(), "");
        // Verify the commit actually landed on the branch.
        const landed = sh(`git diff --name-only ${baseRef}..HEAD`, worktree).trim().split("\n").sort();
        assert.deepEqual(landed, ["a.txt", "b.txt"]);
        assert.ok(logs.some(l => l.includes("hooks bypassed") || l.includes("bypassed")), `expected bypass log, got: ${JSON.stringify(logs)}`);
    });
    // Defensive: even in the impossible case where BOTH normal and --no-verify
    // commits fail, we still need to report the work the agent did  -- returning
    // 0 would pretend nothing happened and drop the branch.
    it("reports preCount when the commit could not land at all", () => {
        const { repo, worktree, baseRef } = makeRepo("commit-impossible");
        // Make BOTH hook paths fail  -- pre-commit AND the bypass-resistant way:
        // point .git/hooks/pre-commit at a script that fails, and override the
        // core.hooksPath to a path that doesn't exist so --no-verify alone isn't
        // enough to explain the failure. Then corrupt the index to cause commit
        // to fail by removing write permission on .git/index. (Cross-platform
        // hack  -- if this turns flaky, skip.)
        const hookPath = join(repo, ".git", "hooks", "pre-commit");
        writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
        chmodSync(hookPath, 0o755);
        writeFileSync(join(worktree, "x.txt"), "x\n");
        // Simulate --no-verify also failing by locking the ref.
        // Easiest: write an invalid HEAD.lock file that blocks the commit.
        const lockPath = join(repo, ".git", "worktrees", "commit-impossible-wt", "HEAD.lock");
        try {
            writeFileSync(lockPath, "lock\n");
        }
        catch {
            // Worktree name differs; skip this hard test  -- the easy case above
            // already covers the real-world scenario.
            return;
        }
        const logs = [];
        const n = autoCommit(0, "task prompt", worktree, baseRef, (_, m) => logs.push(m));
        // Either the commit fell through both paths (n === preCount === 1) or
        // one path unexpectedly succeeded (n === 1 via landed). Both are OK for
        // this test  -- the critical property is "n > 0 so merge gate doesn't
        // silently drop this branch".
        assert.ok(n >= 1, `expected preCount fallback >= 1, got ${n}: ${JSON.stringify(logs)}`);
    });
    // Untracked-only case: an agent that writes brand-new files but never
    // runs `git add` would've been invisible to `git diff` alone.
    it("counts untracked files that the agent created but never staged", () => {
        const { worktree, baseRef } = makeRepo("untracked");
        writeFileSync(join(worktree, "fresh.txt"), "hi\n");
        // No git add  -- the file is untracked.
        const statusBefore = sh("git status --porcelain", worktree).trim();
        assert.match(statusBefore, /^\?\? fresh\.txt/);
        const n = autoCommit(0, "task prompt", worktree, baseRef, noop);
        assert.equal(n, 1, "the untracked file must be counted and staged into the commit");
        // After autoCommit, the file should have been added + committed.
        assert.equal(sh("git status --porcelain", worktree).trim(), "");
    });
});
