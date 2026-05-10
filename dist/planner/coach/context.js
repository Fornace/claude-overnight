import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { readFileOrEmpty, readJsonOrNull } from "../../core/fs-helpers.js";
export const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
export async function fetchUrlContent(url, timeoutMs = 5_000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
        clearTimeout(timer);
        if (!resp.ok)
            return null;
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("json"))
            return await resp.text();
        if (ct.includes("text/html")) {
            const html = await resp.text();
            return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
        }
        return (await resp.text()).slice(0, 4000);
    }
    catch {
        return null;
    }
}
export function collectRepoFacts(cwd) {
    const readmeHead = (() => {
        for (const name of ["README.md", "README", "readme.md"]) {
            const body = readFileOrEmpty(join(cwd, name));
            if (body)
                return body.slice(0, 1500);
        }
        return "";
    })();
    const packageJson = (() => {
        const raw = readJsonOrNull(join(cwd, "package.json"));
        if (!raw)
            return null;
        const deps = { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) };
        return {
            name: typeof raw.name === "string" ? raw.name : undefined,
            scripts: raw.scripts && typeof raw.scripts === "object" ? raw.scripts : undefined,
            depSummary: Object.keys(deps).slice(0, 40).join(", "),
        };
    })();
    const safeExec = (cmd, timeoutMs = 1_500) => {
        try {
            return execSync(cmd, { cwd, timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        }
        catch {
            return "";
        }
    };
    const gitStatus = safeExec("git status --porcelain").slice(0, 800);
    const gitBranch = safeExec("git rev-parse --abbrev-ref HEAD").slice(0, 120);
    const gitLog = safeExec("git log --oneline -20").slice(0, 2000);
    const tree = (() => {
        try {
            return readdirSync(cwd).filter(n => !n.startsWith(".") || n === ".env").slice(0, 60);
        }
        catch {
            return [];
        }
    })();
    const hasEnv = [".env", ".env.local", ".env.development"].some(n => {
        try {
            return existsSync(join(cwd, n));
        }
        catch {
            return false;
        }
    });
    const hasTests = ["tests", "__tests__", "test", "spec"].some(n => {
        try {
            return existsSync(join(cwd, n)) && statSync(join(cwd, n)).isDirectory();
        }
        catch {
            return false;
        }
    });
    const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].filter(n => {
        try {
            return existsSync(join(cwd, n));
        }
        catch {
            return false;
        }
    });
    const priorRuns = (() => {
        try {
            const dir = join(cwd, ".claude-overnight", "runs");
            return readdirSync(dir).length;
        }
        catch {
            return 0;
        }
    })();
    const srcFileCount = (() => {
        const out = safeExec("git ls-files", 2_000);
        if (!out)
            return 0;
        const lines = out.split("\n").filter(Boolean);
        return lines.filter(l => /^(src|app|lib)\//.test(l)).length;
    })();
    return { cwd, readmeHead, packageJson, gitStatus, gitBranch, gitLog, tree, hasEnv, hasTests, lockfiles, priorRuns, srcFileCount };
}
function renderProviders(providers) {
    const lines = [];
    const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
    lines.push(`- Anthropic direct: ${hasAnthropicKey ? "available (env)" : "not configured (no ANTHROPIC_API_KEY / Claude session)"}`);
    if (providers.length === 0) {
        lines.push("- No custom providers saved in ~/.claude/claude-overnight/providers.json");
    }
    else {
        for (const p of providers) {
            const tag = p.cursorProxy ? " · cursor proxy" : (p.useJWT ? " · JWT" : "");
            const keySrc = p.keyEnv ? `env ${p.keyEnv}` : (p.cursorApiKey || p.key ? "stored key" : "no key");
            lines.push(`- ${p.displayName} → model="${p.model}"${tag} (${keySrc})`);
        }
    }
    return lines.join("\n");
}
export function renderRepoFacts(f, rawObjective, providers, cliFlags, planContent) {
    const sections = [];
    sections.push(`# Raw user objective\n\n${rawObjective}`);
    if (planContent)
        sections.push(`# Linked plan (fetched from URL in objective)\n\n${planContent}`);
    sections.push(`# Repo facts\n\n- cwd: ${f.cwd}\n- git branch: ${f.gitBranch || "(unknown)"}\n- source files (src|app|lib): ${f.srcFileCount}\n- prior claude-overnight runs: ${f.priorRuns}\n- .env present: ${f.hasEnv}\n- tests dir: ${f.hasTests}\n- lockfiles: ${f.lockfiles.join(", ") || "(none)"}`);
    if (Object.keys(cliFlags).length > 0) {
        const flagLines = Object.entries(cliFlags).map(([k, v]) => `  --${k}=${v}`).join("\n");
        sections.push(`# CLI flags (user-specified constraints)\n\n${flagLines}`);
    }
    sections.push(`# Available providers (recommend ONLY models the user can reach)\n\n${renderProviders(providers)}`);
    if (f.packageJson) {
        const scripts = f.packageJson.scripts ? Object.entries(f.packageJson.scripts).slice(0, 15).map(([k, v]) => `  ${k}: ${v}`).join("\n") : "(none)";
        sections.push(`# package.json\n\nname: ${f.packageJson.name ?? "(none)"}\n\nscripts:\n${scripts}\n\ndeps: ${f.packageJson.depSummary ?? "(none)"}`);
    }
    if (f.gitStatus)
        sections.push(`# git status --porcelain\n\n${f.gitStatus}`);
    if (f.gitLog)
        sections.push(`# git log (last 20)\n\n${f.gitLog}`);
    if (f.readmeHead)
        sections.push(`# README head\n\n${f.readmeHead}`);
    if (f.tree.length)
        sections.push(`# top-level entries\n\n${f.tree.join(", ")}`);
    return sections.join("\n\n");
}
