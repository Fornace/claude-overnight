export const STEER_CASES = [
    {
        name: "idle-needs-verify",
        hash: "",
        promptPath: "30_wave/30-1_steer",
        vars: {
            objective: "Fix the pagination bug and ensure it works on mobile.",
            status: "Pagination logic has been rewritten. Tests pass. We have not run the app to check mobile responsiveness yet.",
            recentText: "Wave 2 finished: 1 feature agent refactored the logic.",
            fastModel: "qwen",
            workerModel: "sonnet",
            longArchetypes: true,
        },
        criteria: {
            independentTasks: true,
            specificTasks: false,
            requiredJsonFields: ["done", "reasoning", "statusUpdate", "estimatedSessionsRemaining", "tasks"],
        },
    },
    {
        name: "infinite-loop-stuck",
        hash: "",
        promptPath: "30_wave/30-1_steer",
        vars: {
            objective: "Migrate the database to PostgreSQL.",
            status: "Agent keeps failing to connect to the database. It has tried 5 times with different credentials.",
            recentText: "Wave 4 finished: Agent failed to run migrations due to 'Connection refused'.",
            fastModel: "qwen",
            workerModel: "sonnet",
            longArchetypes: true,
        },
        criteria: {
            independentTasks: true,
            specificTasks: false,
            requiredJsonFields: ["done", "reasoning", "statusUpdate", "estimatedSessionsRemaining", "tasks"],
        },
    },
    {
        name: "completed-all-requirements",
        hash: "",
        promptPath: "30_wave/30-1_steer",
        vars: {
            objective: "Add a dark mode toggle to the header.",
            status: "Toggle component created, state management added, CSS updated. Verification agent confirmed the toggle works and persists across reloads.",
            recentText: "Wave 3 finished: Verification agent reported full success.",
            fastModel: "qwen",
            workerModel: "sonnet",
            longArchetypes: true,
        },
        criteria: {
            independentTasks: true,
            specificTasks: false,
            requiredJsonFields: ["done", "reasoning", "statusUpdate", "estimatedSessionsRemaining", "tasks"],
        },
    },
    {
        name: "mid-feature-split",
        hash: "",
        promptPath: "30_wave/30-1_steer",
        vars: {
            objective: "Build a new analytics dashboard with 3 charts.",
            status: "Database queries are written. We need to build the UI components and wire them up.",
            recentText: "Wave 1 finished: Backend agent successfully added the SQL views.",
            fastModel: "qwen",
            workerModel: "sonnet",
            longArchetypes: true,
        },
        criteria: {
            independentTasks: true,
            specificTasks: true,
            requiredJsonFields: ["done", "reasoning", "statusUpdate", "estimatedSessionsRemaining", "tasks"],
        },
    }
];
function hashCase(c) {
    const key = `${c.promptPath}:${c.variant ?? "default"}:${JSON.stringify(c.vars)}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36).slice(0, 8);
}
for (const c of STEER_CASES) {
    c.hash = hashCase(c);
}
