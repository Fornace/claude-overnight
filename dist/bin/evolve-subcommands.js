export async function runDiff(runIdA, runIdB) {
    if (!runIdA || !runIdB) {
        console.error("usage: claude-overnight-evolve diff <runIdA> <runIdB>");
        process.exit(2);
    }
    const { loadRun } = await import("../prompt-evolution/persistence.js");
    const a = loadRun(runIdA);
    const b = loadRun(runIdB);
    const collect = (run) => {
        const out = new Map();
        for (const rec of run.matrix) {
            // Keep the latest-generation row per variantId so diff compares final state.
            const existing = out.get(rec.variantId);
            if (!existing || rec.generation > existing.generation) {
                out.set(rec.variantId, { generation: rec.generation, variantId: rec.variantId, gmean: rec.gmean });
            }
        }
        return out;
    };
    const rowsA = collect(a);
    const rowsB = collect(b);
    const ids = new Set([...rowsA.keys(), ...rowsB.keys()]);
    console.log(`# Diff: ${runIdA} → ${runIdB}`);
    console.log("");
    console.log(`|  Variant  |  A gmean  |  B gmean  |   Δ   |  note  |`);
    console.log(`|-----------|-----------|-----------|-------|--------|`);
    const sorted = [...ids].sort();
    for (const id of sorted) {
        const ra = rowsA.get(id);
        const rb = rowsB.get(id);
        const ga = ra ? (ra.gmean * 100).toFixed(1) : "—";
        const gb = rb ? (rb.gmean * 100).toFixed(1) : "—";
        const delta = ra && rb ? ((rb.gmean - ra.gmean) * 100).toFixed(1) : "—";
        const note = !ra ? "new in B" : !rb ? "missing in B" : ra.gmean < rb.gmean ? "↑" : ra.gmean > rb.gmean ? "↓" : "=";
        console.log(`| ${id.padEnd(10)}| ${ga.padStart(9)} | ${gb.padStart(9)} | ${delta.padStart(5)} | ${note} |`);
    }
}
export async function runDownload(runIdArg, ...rest) {
    if (!runIdArg) {
        console.error("usage: claude-overnight-evolve download <runId> --base-url <url> [--token <token>] [--project <id>]");
        process.exit(2);
    }
    const runId = runIdArg;
    let baseUrl;
    let token;
    let projectId;
    let watch = false;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--base-url" && rest[i + 1]) {
            baseUrl = rest[i + 1];
            i++;
        }
        else if (rest[i] === "--token" && rest[i + 1]) {
            token = rest[i + 1];
            i++;
        }
        else if (rest[i] === "--project" && rest[i + 1]) {
            projectId = rest[i + 1];
            i++;
        }
        else if (rest[i] === "--watch") {
            watch = true;
        }
    }
    if (!baseUrl) {
        console.error("--base-url is required (e.g. https://fornace.net or http://localhost:8787)");
        process.exit(2);
    }
    const authHeaders = {};
    if (token)
        authHeaders.Authorization = `Bearer ${token}`;
    const prefix = projectId
        ? `${baseUrl.replace(/\/$/, "")}/api/projects/${projectId}/prompt-evolution/${runId}`
        : `${baseUrl.replace(/\/$/, "")}/runs/${runId}`;
    let remoteMeta = null;
    let metaBody = null;
    while (true) {
        const metaRes = await fetch(prefix, { headers: authHeaders });
        if (!metaRes.ok) {
            console.error(`Failed to fetch run metadata: HTTP ${metaRes.status}`);
            process.exit(1);
        }
        metaBody = (await metaRes.json());
        remoteMeta = typeof metaBody.meta === "object" && metaBody.meta
            ? metaBody.meta
            : metaBody;
        const status = remoteMeta.status;
        if (watch && (status === "running" || status === "queued" || status === "pending" || !status)) {
            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Run ${runId} is ${status || "running"}... waiting... `);
            await new Promise(r => setTimeout(r, 10000));
        }
        else {
            if (watch)
                console.log(`\nRun finished with status: ${status}`);
            break;
        }
    }
    const { runDir } = await import("../prompt-evolution/persistence.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const localDir = runDir(runId);
    mkdirSync(localDir, { recursive: true });
    mkdirSync(join(localDir, "prompts"), { recursive: true });
    const meta = {
        runId,
        promptPath: (remoteMeta.promptPath ?? remoteMeta.prompt ?? ""),
        target: (remoteMeta.target ?? "claude-overnight"),
        evalModel: (remoteMeta.evalModel ?? ""),
        mutateModel: (remoteMeta.mutateModel ?? remoteMeta.evalModel ?? ""),
        generations: (remoteMeta.generations ?? 10),
        populationCap: (remoteMeta.populationCap ?? remoteMeta.population ?? 8),
        startedAt: (remoteMeta.startedAt ?? remoteMeta.queuedAt ?? new Date().toISOString()),
        status: (remoteMeta.status ?? "done"),
        caseNames: [],
    };
    writeFileSync(join(localDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    const inlineReport = typeof metaBody.report === "string" ? metaBody.report : metaBody.report_md;
    if (typeof inlineReport === "string") {
        writeFileSync(join(localDir, "report.md"), inlineReport);
        console.log("  ✓ report.md (inline)");
    }
    const listRes = await fetch(`${prefix}/files`, { headers: authHeaders });
    let files = [];
    if (listRes.ok) {
        const listBody = (await listRes.json());
        files = listBody.files ?? [];
    }
    else {
        console.log(`  ⚠ File listing not available (HTTP ${listRes.status}); trying known files...`);
        files = ["report.md", "best.md", "matrix.jsonl", "learning.jsonl"];
    }
    for (const file of files) {
        const fileRes = await fetch(`${prefix}/files/${encodeURIComponent(file)}`, { headers: authHeaders });
        if (!fileRes.ok) {
            console.error(`  ⚠ ${file}: HTTP ${fileRes.status}`);
            continue;
        }
        const data = Buffer.from(await fileRes.arrayBuffer());
        const localPath = join(localDir, file);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, data);
        console.log(`  ✓ ${file}`);
    }
    const matrixPath = join(localDir, "matrix.jsonl");
    const { existsSync, readFileSync } = await import("node:fs");
    if (existsSync(matrixPath)) {
        const variantIds = new Set();
        for (const line of readFileSync(matrixPath, "utf-8").trim().split("\n")) {
            if (!line)
                continue;
            try {
                const row = JSON.parse(line);
                if (row.variantId)
                    variantIds.add(row.variantId);
            }
            catch { /* ignore */ }
        }
        for (const vid of variantIds) {
            const safeId = vid.replace(/[^a-zA-Z0-9_-]/g, "_");
            const promptFile = `prompts/${safeId}.md`;
            if (existsSync(join(localDir, promptFile)))
                continue;
            const fileRes = await fetch(`${prefix}/files/${encodeURIComponent(promptFile)}`, { headers: authHeaders });
            if (!fileRes.ok)
                continue;
            const data = Buffer.from(await fileRes.arrayBuffer());
            mkdirSync(dirname(join(localDir, promptFile)), { recursive: true });
            writeFileSync(join(localDir, promptFile), data);
            console.log(`  ✓ ${promptFile} (from matrix)`);
        }
    }
    console.log(`\nDownloaded to ${localDir}`);
}
export async function runPromote(runIdArg, ...rest) {
    if (!runIdArg) {
        console.error("usage: claude-overnight-evolve promote <runId> [--variant <id>] [--into <block>]");
        process.exit(2);
    }
    const runId = runIdArg;
    let variantId;
    let intoBlock;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--variant" && rest[i + 1]) {
            variantId = rest[i + 1];
            i++;
        }
        else if (rest[i] === "--into" && rest[i + 1]) {
            intoBlock = rest[i + 1];
            i++;
        }
    }
    const { loadRun, runDir } = await import("../prompt-evolution/persistence.js");
    const { PROMPTS_ROOT } = await import("../prompts/load.js");
    const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const run = loadRun(runId);
    const promptPath = run.meta.promptPath;
    let sourceVariant = variantId;
    if (!sourceVariant) {
        const bestMatch = run.bestMd.match(/variantId\s*\|\s*`([^`]+)`/);
        sourceVariant = bestMatch ? bestMatch[1] : undefined;
        if (!sourceVariant) {
            const rows = run.matrix;
            if (rows.length)
                sourceVariant = [...rows].sort((a, b) => b.gmean - a.gmean)[0].variantId;
        }
    }
    if (!sourceVariant) {
        console.error("Could not determine best variant for run. Use --variant <id>.");
        process.exit(2);
    }
    const safeId = sourceVariant.replace(/[^a-zA-Z0-9_-]/g, "_");
    const variantFile = join(runDir(runId), "prompts", `${safeId}.md`);
    if (!existsSync(variantFile)) {
        console.error(`Variant file not found: ${variantFile}`);
        process.exit(2);
    }
    const variantText = readFileSync(variantFile, "utf-8").replace(/^<!--\s*generation=[\s\S]*?-->\n\n?/, "");
    const namedVariants = ["tight", "standard", "large", "wrap", "amend", "wave", "run", "file", "all", "postfailed", "nofiles"];
    const targetBlock = intoBlock ?? (namedVariants.includes(sourceVariant.toLowerCase()) ? sourceVariant : undefined);
    if (!targetBlock) {
        console.error(`Variant "${sourceVariant}" is not a named seed variant. Use --into <block> to specify which marker block to overwrite.`);
        process.exit(2);
    }
    const promptFile = join(PROMPTS_ROOT, promptPath + ".md");
    if (!existsSync(promptFile)) {
        console.error(`Prompt file not found: ${promptFile}`);
        process.exit(2);
    }
    const newText = replaceVariantBlock(readFileSync(promptFile, "utf-8"), targetBlock, variantText);
    writeFileSync(promptFile, newText);
    console.log(`Promoted ${sourceVariant} → ${promptPath} (<!-- ${targetBlock.toUpperCase()} -->)`);
    console.log(`  file: ${promptFile}`);
}
function replaceVariantBlock(fileText, blockName, newText) {
    const separator = "\n<!-- @@@ -->\n";
    const sections = fileText.split(separator);
    const markerRegex = new RegExp(`<!--\\s*(?:[─\\-]+\\s*)?${blockName.toUpperCase()}\\s*-->`, "i");
    let found = false;
    const newSections = sections.map((section) => {
        const lines = section.split("\n");
        const markerIndex = lines.findIndex((line) => markerRegex.test(line));
        if (markerIndex === -1)
            return section;
        found = true;
        const before = lines.slice(0, markerIndex + 1);
        return [...before, "", newText.trim(), ""].join("\n").trimEnd() + "\n";
    });
    if (!found)
        throw new Error(`Variant block "${blockName.toUpperCase()}" not found in prompt file`);
    return newSections.join(separator);
}
