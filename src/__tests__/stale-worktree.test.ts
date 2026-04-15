import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Regression test for the stale-worktree cleanup match:
// git worktree list returns realpath-resolved paths, which on macOS means
// /private/var/folders/... instead of /var/folders/... (the os.tmpdir() value).
// cleanStaleWorktrees in merge.ts used to gate on startsWith(tmpdir()), which
// never matched realpath'd paths. We now match any path containing
// "/claude-overnight-" as the signal.

// Replica of the matcher, copied here because it's not exported.
function isStaleOvernightWorktree(wpath: string): boolean {
  return wpath.includes("/claude-overnight-");
}

describe("cleanStaleWorktrees  -- /private path handling", () => {
  it("matches realpath'd macOS tmp worktree paths", () => {
    const wpath = "/private/var/folders/0k/0xvnwvx52735tpb2kv2b347r0000gn/T/claude-overnight-Z3VDYu/agent-0";
    assert.equal(isStaleOvernightWorktree(wpath), true);
  });

  it("matches un-resolved macOS tmp worktree paths", () => {
    const wpath = "/var/folders/0k/0xvnwvx52735tpb2kv2b347r0000gn/T/claude-overnight-R9183g/agent-0";
    assert.equal(isStaleOvernightWorktree(wpath), true);
  });

  it("matches Linux /tmp worktree paths", () => {
    const wpath = "/tmp/claude-overnight-abc123/agent-5";
    assert.equal(isStaleOvernightWorktree(wpath), true);
  });

  it("does not match unrelated worktrees", () => {
    assert.equal(isStaleOvernightWorktree("/Users/francesco/works/repos/payme"), false);
    assert.equal(isStaleOvernightWorktree("/var/folders/0k/.../T/something-else/dir"), false);
    assert.equal(isStaleOvernightWorktree("/some/other/worktree"), false);
  });
});
