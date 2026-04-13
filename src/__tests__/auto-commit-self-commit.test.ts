import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCommit } from "../merge.js";

// Regression test for the pre-1.11.10 filesChanged=0 orphan-branch bug.
//
// autoCommit() used to measure work by counting `git status --porcelain` lines
// in the worktree. When an agent committed its own work (common — some agents
// prefer to own their git hygiene), the worktree was clean at measurement time,
// `status --porcelain` returned empty, autoCommit returned 0, and the branch was
// dropped from the merge gate (`filesChanged > 0`) — the commit survived on the
// branch but never landed in main, silently orphaned.
//
// The fix: measure filesChanged from `<baseRef>..HEAD` diff. This is correct
// regardless of who made the commits.
//
// See payme run 2026-04-12T13-03-57: 15/53 tasks hit this bug.

const tmp = mkdtempSync(join(tmpdir(), "co-auto-commit-"));
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

function sh(cmd: string, cwd: string) {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function makeRepo(name: string): { repo: string; worktree: string; baseRef: string } {
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

const noop = () => {};

describe("autoCommit — agent-self-commit accounting (regression)", () => {
  it("counts files when the agent already committed its work", () => {
    const { worktree, baseRef } = makeRepo("self-commit");

    // Agent writes and commits its own work — worktree ends up CLEAN.
    writeFileSync(join(worktree, "a.txt"), "a\n");
    writeFileSync(join(worktree, "b.txt"), "b\n");
    sh("git add -A && git commit -q -m 'agent self commit'", worktree);
    const status = sh("git status --porcelain", worktree).trim();
    assert.equal(status, "", "worktree must be clean — this is the bug's precondition");

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
});
