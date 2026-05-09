// Filesystem layout of a single run dir. Keeps the on-disk schema in one
// place so resume.ts and plan-phase.ts don't bake "tasks.json" / "designs"
// strings independently.

import { join } from "path";

export const tasksJsonPath = (runDir: string) => join(runDir, "tasks.json");
export const designsDir = (runDir: string) => join(runDir, "designs");
export const themesMdPath = (runDir: string) => join(runDir, "themes.md");
export const statusMdPath = (runDir: string) => join(runDir, "status.md");
