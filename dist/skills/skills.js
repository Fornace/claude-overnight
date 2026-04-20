// Entry re-exports for the skills folder — follows the swarm/swarm.ts pattern.
export { writeCandidate } from "./scribe.js";
export { computeRepoFingerprint } from "../core/fingerprint.js";
export { openSkillsDb, queryCandidateL0, queryRecipeL0, recordEvent, incrementUse, resetDb } from "./index-db.js";
export { runLibrarian } from "./librarian.js";
export { buildL0Stub, buildRecipeStub } from "./injection.js";
export { skillReadTool, skillSearchTool } from "./tools.js";
export { pickAbSkill, recordAbOutcome } from "./ab.js";
export { queryAbEligibleSkills, markAbTrial } from "./index-db.js";
