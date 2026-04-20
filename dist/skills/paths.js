import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const REAL_ROOT = join(homedir(), ".claude-overnight", "skills");
let _override;
function root() {
    return _override ?? REAL_ROOT;
}
/** Test-only: redirect skillsRoot to a temp dir. */
export function __setRoot(dir) { _override = dir; }
/** Test-only: restore the real root. */
export function __restoreRoot() { _override = undefined; }
function ensure(dir) {
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function skillsRoot() {
    return ensure(root());
}
export function fingerprintDir(fp) {
    return ensure(join(root(), fp));
}
export function candidatesDir(fp) {
    return ensure(join(root(), fp, "candidates"));
}
export function canonDir(fp) {
    return ensure(join(root(), fp, "canon"));
}
export function recipeDir(fp) {
    return ensure(join(root(), fp, "canon", "recipe"));
}
export function quarantineDir(fp) {
    return ensure(join(root(), fp, "quarantine"));
}
export function indexPath() {
    return join(root(), "index.sqlite");
}
