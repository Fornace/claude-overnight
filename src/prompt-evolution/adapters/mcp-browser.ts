/**
 * MCP-browser prompt adapter.
 *
 * MCP-browser stores prompts as inline template literals in
 * platform/supervisor/gemini-client.ts. This adapter:
 * 1. Extracts those prompt strings by parsing the TS file
 * 2. Defines benchmark cases for each prompt type
 * 3. Provides repo contexts for planning/refinement evaluation
 *
 * The prompts are evaluated by sending them to a model (via OpenRouter
 * or any Anthropic-compatible proxy) and scoring the structured output.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchmarkCase, PromptVars } from "../types.js";

/**
 * Resolve the path to `gemini-client.ts` inside whichever MCP-browser checkout
 * is in scope. Order:
 *   1. `MCP_BROWSER_GEMINI_CLIENT` env var — explicit override.
 *   2. `MCP_BROWSER_REPO` env var — repo root, relative file is appended.
 *   3. cwd — expected shape on fornace.net (inside the project's raw container
 *      the repo is cloned at `/workspace`, so `process.cwd()` resolves it).
 *
 * NEVER hardcode an absolute host path — this runs in a container on the
 * server and on any contributor's laptop.
 */
function resolveGeminiClientPath(): string {
  const override = process.env.MCP_BROWSER_GEMINI_CLIENT;
  if (override) return resolve(override);
  const repo = process.env.MCP_BROWSER_REPO ?? process.cwd();
  return resolve(repo, "platform/supervisor/gemini-client.ts");
}

/** Prompt kinds we can benchmark */
export type McpPromptKind =
  | "planning"
  | "review"
  | "evolution"
  | "goal-refinement"
  | "plan-supervision"
  | "simple-supervision"
  | "stuck-analysis";

/** Extract a const prompt string from gemini-client.ts by name */
export function extractPrompt(kind: McpPromptKind): string {
  const path = resolveGeminiClientPath();
  const source = readFileSync(path, "utf-8");
  const nameMap: Record<McpPromptKind, string> = {
    planning: "PLANNING_PROMPT",
    review: "REVIEW_PROMPT",
    evolution: "EVOLUTION_PROMPT",
    "goal-refinement": "GOAL_REFINEMENT_PROMPT",
    "plan-supervision": "PLAN_SUPERVISION_PROMPT",
    "simple-supervision": "SIMPLE_SUPERVISION_PROMPT",
    "stuck-analysis": "STUCK_ANALYSIS_PROMPT",
  };
  const constName = nameMap[kind];
  const pattern = new RegExp(`const ${constName} = \`([\\s\\S]*?)\`;`);
  const m = source.match(pattern);
  if (!m) throw new Error(`Prompt ${constName} not found in ${path}`);
  return m[1].trim();
}

/** Build a synthetic user prompt for a given kind and scenario */
export function buildUserPrompt(kind: McpPromptKind, scenario: McpScenario): string {
  switch (kind) {
    case "planning":
      return buildPlanningUserPrompt(scenario);
    case "review":
      return buildReviewUserPrompt(scenario);
    case "evolution":
      return buildEvolutionUserPrompt(scenario);
    case "goal-refinement":
      return buildGoalRefinementUserPrompt(scenario);
    case "plan-supervision":
      return buildPlanSupervisionUserPrompt(scenario);
    case "simple-supervision":
      return buildSimpleSupervisionUserPrompt(scenario);
    case "stuck-analysis":
      return buildStuckAnalysisUserPrompt(scenario);
  }
}

// ── Scenarios ───────────────────────────────────────────────────────────────

export interface McpScenario {
  name: string;
  repoContext?: RepoContext;
  stepContext?: StepContext;
  terminalContext?: TerminalContext;
  reviewContext?: ReviewContext;
  evolutionContext?: EvolutionContext;
  goalContext?: GoalContext;
}

export interface RepoContext {
  goal: string;
  fileTree: string;
  readmeSnippet: string;
  hasCiCd: boolean;
}

export interface StepContext {
  stepTitle: string;
  stepDescription: string;
  acceptanceCriteria: string[];
  phaseTitle: string;
  progress: string;
}

export interface TerminalContext {
  state: "idle" | "error" | "context_limit" | "completed" | "working";
  recentOutput: string;
  projectGoal: string;
}

export interface ReviewContext {
  stepTitle: string;
  stepDescription: string;
  acceptanceCriteria: string[];
  terminalOutput: string;
}

export interface EvolutionContext {
  completedPlanSummary: string;
  reviewNotes: string;
  evolutionNumber: number;
}

export interface GoalContext {
  originalTitle: string;
  originalDescription: string;
  gitHistory: string;
  fileTree: string;
}

// ── User prompt builders ────────────────────────────────────────────────────

function buildPlanningUserPrompt(s: McpScenario): string {
  const ctx = s.repoContext!;
  const ciCdNote = ctx.hasCiCd
    ? "## CI/CD: GitHub Actions detected — push triggers deployment"
    : "## CI/CD: No CI/CD detected";
  return `Goal: ${ctx.goal}\n\n${ciCdNote}\n## Tools: MCP Browser available for visual verification of UI work\n\nRepository file structure:\n${ctx.fileTree}\n\nREADME/package.json:\n${ctx.readmeSnippet}`;
}

function buildReviewUserPrompt(s: McpScenario): string {
  const ctx = s.reviewContext!;
  return `Step: ${ctx.stepTitle}\nDescription: ${ctx.stepDescription}\nAcceptance Criteria:\n${ctx.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\nTerminal output:\n${ctx.terminalOutput}`;
}

function buildEvolutionUserPrompt(s: McpScenario): string {
  const ctx = s.evolutionContext!;
  return `Completed plan summary:\n${ctx.completedPlanSummary}\n\nReview notes:\n${ctx.reviewNotes}\n\nEvolution number: ${ctx.evolutionNumber}`;
}

function buildGoalRefinementUserPrompt(s: McpScenario): string {
  const ctx = s.goalContext!;
  return `Original goal: ${ctx.originalTitle}\n${ctx.originalDescription}\n\nGit history:\n${ctx.gitHistory}\n\nFile tree:\n${ctx.fileTree}`;
}

function buildPlanSupervisionUserPrompt(s: McpScenario): string {
  const ctx = s.terminalContext!;
  const step = s.stepContext!;
  return `Current step: ${step.stepTitle}\n${step.stepDescription}\nAcceptance criteria: ${step.acceptanceCriteria.join(", ")}\n\nProgress: ${step.progress}\n\nState: ${ctx.state}\n\nRecent terminal output:\n${ctx.recentOutput}\n\nProject goal: ${ctx.projectGoal}`;
}

function buildSimpleSupervisionUserPrompt(s: McpScenario): string {
  const ctx = s.terminalContext!;
  return `Current state: ${ctx.state}\n\nRecent terminal output:\n${ctx.recentOutput}\n\nProject goal: ${ctx.projectGoal}`;
}

function buildStuckAnalysisUserPrompt(s: McpScenario): string {
  const prev = s.terminalContext?.recentOutput ?? "";
  const curr = s.terminalContext?.recentOutput ?? "";
  const step = s.stepContext?.stepDescription ?? "";
  return `Previous snapshot (60s ago):\n${prev}\n\nCurrent snapshot:\n${curr}\n\nCurrent step: ${step}`;
}

// ── Benchmark case definitions ──────────────────────────────────────────────

export const PLANNING_SCENARIOS: McpScenario[] = [
  {
    name: "simple-todo-app",
    repoContext: {
      goal: "Build a simple todo app with localStorage persistence",
      fileTree: `src/
  main.js
  style.css
index.html
package.json
README.md`,
      readmeSnippet: `# Vanilla JS Todo App\nA simple todo list using vanilla JavaScript and localStorage.\n\n## Scripts\n- \`npm run dev\` - start dev server\n- \`npm run build\` - build for production`,
      hasCiCd: false,
    },
  },
  {
    name: "auth-system",
    repoContext: {
      goal: "Add a complete user authentication system with JWT tokens, password reset, and email verification",
      fileTree: `src/
  routes/
    auth.ts
    user.ts
  models/
    user.ts
  middleware/
    auth.ts
  utils/
    email.ts
package.json
tsconfig.json
README.md
.github/workflows/ci.yml`,
      readmeSnippet: `# Express API\nREST API built with Express, TypeScript, and Prisma.\n\n## Stack\n- Express 4\n- TypeScript 5\n- Prisma ORM\n- PostgreSQL\n- JWT auth (existing, basic)\n\n## CI/CD\nGitHub Actions runs tests and deploys to Railway on push to main.`,
      hasCiCd: true,
    },
  },
  {
    name: "large-refactor",
    repoContext: {
      goal: "Migrate the entire frontend from React class components to functional components with hooks. Update tests, stories, and documentation.",
      fileTree: `src/
  components/
    Button.tsx
    Modal.tsx
    Table.tsx
    Form.tsx
    Dashboard.tsx
  pages/
    Home.tsx
    Profile.tsx
    Settings.tsx
  tests/
    Button.test.tsx
    Modal.test.tsx
  stories/
    Button.stories.tsx
package.json
tsconfig.json
README.md
vite.config.ts
.github/workflows/deploy.yml`,
      readmeSnippet: `# React Admin Dashboard\nEnterprise admin dashboard built with React 17 and class components.\n\n## Stack\n- React 17 (class components)\n- TypeScript\n- Vite\n- React Testing Library\n- Storybook\n\n## Components\n20+ components using legacy class-based patterns.`,
      hasCiCd: true,
    },
  },
];

export const REVIEW_SCENARIOS: McpScenario[] = [
  {
    name: "passing-step",
    reviewContext: {
      stepTitle: "Implement user login endpoint",
      stepDescription: "Create POST /api/auth/login that validates credentials and returns JWT",
      acceptanceCriteria: [
        "Endpoint accepts email and password",
        "Returns 200 with JWT on valid credentials",
        "Returns 401 on invalid credentials",
        "Passwords are compared with bcrypt",
      ],
      terminalOutput: `> npm test
 PASS  src/routes/auth.test.ts
  POST /api/auth/login
    ✓ accepts email and password (45ms)
    ✓ returns 200 with JWT on valid credentials (32ms)
    ✓ returns 401 on invalid credentials (28ms)
    ✓ compares passwords with bcrypt (41ms)

Test Suites: 1 passed, 1 total`,
    },
  },
  {
    name: "failing-step",
    reviewContext: {
      stepTitle: "Add input validation middleware",
      stepDescription: "Create validation middleware for all API routes using zod",
      acceptanceCriteria: [
        "All POST routes have body validation",
        "Returns 400 with field-level errors",
        "Validation schema is reusable",
      ],
      terminalOutput: `> npm test
 FAIL  src/middleware/validation.test.ts
  validation middleware
    ✓ validates login body (30ms)
    ✗ returns 400 with field-level errors (15ms)
      Expected status 400, got 500
    ✗ validation schema is reusable (12ms)
      Schema is hardcoded in each route

Test Suites: 1 failed, 1 total`,
    },
  },
];

export const SUPERVISION_SCENARIOS: McpScenario[] = [
  {
    name: "idle-needs-work",
    terminalContext: {
      state: "idle",
      recentOutput: `$ claude`,
      projectGoal: "Add OAuth2 login with Google",
    },
    stepContext: {
      stepTitle: "Set up Google OAuth client",
      stepDescription: "Configure Google OAuth2 credentials and callback URL",
      acceptanceCriteria: ["Client ID and secret in .env", "Callback route registered"],
      phaseTitle: "Authentication",
      progress: "Phase 1/3 · Step 1/4",
    },
  },
  {
    name: "working-busy",
    terminalContext: {
      state: "working",
      recentOutput: `> Installing dependencies...
+ passport@0.6.0
+ passport-google-oauth20@2.0.0
added 47 packages in 2s
> Writing src/config/oauth.ts...`,
      projectGoal: "Add OAuth2 login with Google",
    },
    stepContext: {
      stepTitle: "Set up Google OAuth client",
      stepDescription: "Configure Google OAuth2 credentials and callback URL",
      acceptanceCriteria: ["Client ID and secret in .env", "Callback route registered"],
      phaseTitle: "Authentication",
      progress: "Phase 1/3 · Step 1/4",
    },
  },
  {
    name: "unblock-yesno",
    terminalContext: {
      state: "idle",
      recentOutput: `Claude has made changes to src/config/oauth.ts. Commit these changes? (Y/n)`,
      projectGoal: "Add OAuth2 login with Google",
    },
    stepContext: {
      stepTitle: "Set up Google OAuth client",
      stepDescription: "Configure Google OAuth2 credentials and callback URL",
      acceptanceCriteria: ["Client ID and secret in .env", "Callback route registered"],
      phaseTitle: "Authentication",
      progress: "Phase 1/3 · Step 1/4",
    },
  },
];

export const STUCK_SCENARIOS: McpScenario[] = [
  {
    name: "infinite-loop",
    terminalContext: {
      state: "working",
      recentOutput: `Error: Cannot find module './oauth'
    at src/routes/auth.ts:3
Error: Cannot find module './oauth'
    at src/routes/auth.ts:3
Error: Cannot find module './oauth'
    at src/routes/auth.ts:3`,
      projectGoal: "Add OAuth2 login with Google",
    },
    stepContext: {
      stepTitle: "Fix import paths",
      stepDescription: "Resolve module import errors in auth routes",
      acceptanceCriteria: ["All imports resolve correctly"],
      phaseTitle: "Authentication",
      progress: "Phase 1/3 · Step 2/4",
    },
  },
  {
    name: "hanging-build",
    terminalContext: {
      state: "working",
      recentOutput: `> npm run build
[webpack] Building...`,
      projectGoal: "Add OAuth2 login with Google",
    },
    stepContext: {
      stepTitle: "Verify build passes",
      stepDescription: "Run production build and fix any TypeScript errors",
      acceptanceCriteria: ["Build completes without errors"],
      phaseTitle: "Authentication",
      progress: "Phase 1/3 · Step 3/4",
    },
  },
];

/** Convert scenarios to benchmark cases for a given prompt kind */
export function scenariosToCases(kind: McpPromptKind, scenarios: McpScenario[]): BenchmarkCase[] {
  const systemPrompt = extractPrompt(kind);
  return scenarios.map((s) => {
    const vars: PromptVars = {
      userPrompt: buildUserPrompt(kind, s),
    };
    return {
      name: `${kind}:${s.name}`,
      hash: "",
      promptPath: `mcp-browser/${kind}`,
      vars,
      criteria: criteriaForKind(kind),
      systemPrompt,
    };
  });
}

function criteriaForKind(kind: McpPromptKind): BenchmarkCase["criteria"] {
  switch (kind) {
    case "planning":
      return {
        requiredJsonFields: ["summary", "phases", "techStack", "risks"],
        independentTasks: false, // planning steps CAN depend on previous
        specificTasks: true,
      };
    case "review":
      return {
        requiredJsonFields: ["passed", "score", "notes", "discoveredGoals"],
      };
    case "evolution":
      return {
        requiredJsonFields: ["summary", "phases", "techStack", "risks"],
      };
    case "goal-refinement":
      return {
        requiredJsonFields: ["shouldSplit", "refinedTitle", "refinedDescription", "refinedPriority", "refinedCategory"],
      };
    case "plan-supervision":
      return {
        requiredJsonFields: ["action", "detail", "activityTitle", "activityDetail", "activityIcon"],
      };
    case "simple-supervision":
      return {
        requiredJsonFields: ["action", "detail"],
      };
    case "stuck-analysis":
      return {
        requiredJsonFields: ["stuck", "command", "reasoning", "activityTitle", "activityDetail"],
      };
  }
}

// Auto-fill hashes
function hashCase(c: BenchmarkCase): string {
  const key = `${c.promptPath}:${JSON.stringify(c.vars)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

export function hydrateCases(cases: BenchmarkCase[]): BenchmarkCase[] {
  for (const c of cases) {
    if (!c.hash) c.hash = hashCase(c);
  }
  return cases;
}
