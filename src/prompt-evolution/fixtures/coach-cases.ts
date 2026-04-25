import type { BenchmarkCase } from "../types.js";

export const COACH_CASES: BenchmarkCase[] = [
  {
    name: "simple-todo",
    hash: "",
    promptPath: "00_setup/00-1_coach",
    vars: {
      objective: "Build a simple todo app using vanilla JS.",
      tree: "index.html\nstyle.css\napp.js",
      readme: "# Todo app",
      providers: "anthropic, openai",
      isInitialCoach: true,
    },
    criteria: {
      independentTasks: false,
      specificTasks: false,
      requiredJsonFields: ["objective", "scope", "recommended", "checklist", "remediation"],
    },
  },
  {
    name: "vague-objective",
    hash: "",
    promptPath: "00_setup/00-1_coach",
    vars: {
      objective: "Make it better.",
      tree: "src/main.ts",
      readme: "Project",
      providers: "anthropic",
      isInitialCoach: true,
    },
    criteria: {
      independentTasks: false,
      specificTasks: false,
      requiredJsonFields: ["objective", "scope", "recommended", "checklist", "remediation"],
    },
  },
  {
    name: "massive-refactor",
    hash: "",
    promptPath: "00_setup/00-1_coach",
    vars: {
      objective: "Migrate the entire backend from Express to NestJS.",
      tree: "src/app.ts\nsrc/routes/api.ts\nsrc/models/user.ts",
      readme: "Express backend",
      providers: "anthropic, google",
      isInitialCoach: true,
    },
    criteria: {
      independentTasks: false,
      specificTasks: false,
      requiredJsonFields: ["objective", "scope", "recommended", "checklist", "remediation"],
    },
  },
];

function hashCase(c: BenchmarkCase): string {
  const key = `${c.promptPath}:${c.variant ?? "default"}:${JSON.stringify(c.vars)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

for (const c of COACH_CASES) {
  c.hash = hashCase(c);
}
