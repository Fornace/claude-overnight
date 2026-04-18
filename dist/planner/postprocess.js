export function postProcess(raw, budget, onLog) {
    let tasks = raw;
    const before = tasks.length;
    tasks = tasks.filter((t) => t.prompt && t.prompt.trim().length >= 1);
    if (tasks.length < before)
        onLog(`Filtered ${before - tasks.length} task(s) with empty prompt`);
    // Read-only tasks (verify/audit/user-test) shouldn't get a worktree: they
    // don't change files, so they'd just create empty swarm branches that show
    // up as "0 files changed" noise. Run them in the real project directory so
    // env files, dependencies, and local config are available.
    let readOnly = 0;
    for (const t of tasks) {
        if (!t.noWorktree && /^\s*(verify|audit|user[- ]?test)\b/i.test(t.prompt)) {
            t.noWorktree = true;
            readOnly++;
        }
    }
    if (readOnly > 0)
        onLog(`${readOnly} read-only task(s) marked noWorktree`);
    const dominated = new Set();
    for (let i = 0; i < tasks.length; i++) {
        if (dominated.has(i))
            continue;
        const setA = new Set(tasks[i].prompt.toLowerCase().split(/\s+/));
        for (let j = i + 1; j < tasks.length; j++) {
            if (dominated.has(j))
                continue;
            const setB = new Set(tasks[j].prompt.toLowerCase().split(/\s+/));
            const shared = [...setA].filter((w) => setB.has(w)).length;
            const overlap = shared / Math.max(setA.size, setB.size);
            if (overlap > 0.8) {
                const drop = setA.size >= setB.size ? j : i;
                dominated.add(drop);
                if (drop === i)
                    break;
            }
        }
    }
    if (dominated.size) {
        tasks = tasks.filter((_, i) => !dominated.has(i));
        onLog(`Deduplicated to ${tasks.length} tasks`);
    }
    // File-path overlap: merge tasks targeting the same file to prevent
    // concurrent edits causing merge conflicts. Only applies to execute tasks.
    if ((budget ?? 10) <= 15) {
        const fileRe = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
        const adj = new Map();
        for (let i = 0; i < tasks.length; i++)
            adj.set(i, new Set());
        const pathToIndices = new Map();
        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            if (t.type && t.type !== "execute")
                continue;
            for (const m of t.prompt.matchAll(fileRe)) {
                const indices = pathToIndices.get(m[1]);
                if (indices) {
                    for (const j of indices) {
                        adj.get(i).add(j);
                        adj.get(j).add(i);
                    }
                    indices.push(i);
                }
                else {
                    pathToIndices.set(m[1], [i]);
                }
            }
        }
        const visited = new Set();
        let totalMerged = 0;
        for (let i = 0; i < tasks.length; i++) {
            if (visited.has(i) || adj.get(i).size === 0)
                continue;
            const component = [];
            const stack = [i];
            while (stack.length > 0) {
                const curr = stack.pop();
                if (visited.has(curr))
                    continue;
                visited.add(curr);
                component.push(curr);
                for (const nb of adj.get(curr))
                    if (!visited.has(nb))
                        stack.push(nb);
            }
            if (component.length > 1) {
                const prompts = component.map((idx) => tasks[idx].prompt);
                const merged = { ...tasks[component[0]], id: tasks[component[0]].id, prompt: prompts.join("\n\nAlso: ") };
                component.sort((a, b) => b - a);
                for (const idx of component.slice(1))
                    tasks.splice(idx, 1);
                tasks[component[0]] = merged;
                totalMerged += component.length - 1;
            }
        }
        if (totalMerged > 0)
            onLog(`Merged ${totalMerged} overlapping task(s) into combined tasks`);
    }
    const cap = budget ? Math.ceil(budget * 1.2) : 30;
    if (tasks.length > cap) {
        onLog(`Truncating ${tasks.length} → ${cap}`);
        tasks = tasks.slice(0, cap);
    }
    tasks.sort((a, b) => Number(/\btest/i.test(a.prompt)) - Number(/\btest/i.test(b.prompt)));
    return tasks.map((t, i) => ({ ...t, id: String(i) }));
}
