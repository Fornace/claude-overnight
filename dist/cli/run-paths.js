// Filesystem layout of a single run dir. Keeps the on-disk schema in one
// place so resume.ts and plan-phase.ts don't bake "tasks.json" / "designs"
// strings independently.
import { join } from "path";
export const tasksJsonPath = (runDir) => join(runDir, "tasks.json");
export const designsDir = (runDir) => join(runDir, "designs");
export const themesMdPath = (runDir) => join(runDir, "themes.md");
export const statusMdPath = (runDir) => join(runDir, "status.md");
