// Cursor model picker and setup wizard.
import { execSync } from "child_process";
import chalk from "chalk";
import { ask, select, selectKey } from "../../cli/cli.js";
import {
  CURSOR_PRIORITY_MODELS,
  CURSOR_KNOWN_MODELS,
  KNOWN_CURSOR_MODEL_IDS,
  cursorModelHint,
} from "../../core/cursor-models.js";
import { loadProviders, saveProvider } from "../store.js";
import type { ProviderConfig } from "../store.js";
import type { ModelPick } from "../index.js";
import {
  PROXY_DEFAULT_URL,
  bundledComposerProxyShellCommand,
  fetchLiveCursorModels,
  resolveCursorAgentToken,
  getClaudeOvernightInstallRoot,
  resolveCursorComposerCli,
} from "./env.js";
import { healthCheckCursorProxy, ensureCursorProxyRunning } from "./proxy.js";

interface SetupStep {
  label: string;
  check: () => boolean;
  autoCmd: string;
  manualCmd: string;
  successMsg: string;
}

function tryBundledComposerHelp(): boolean {
  const cli = resolveCursorComposerCli();
  if (!cli) return false;
  try {
    execSync(`node "${cli}" --help`, { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function setupSteps(): SetupStep[] {
  return [
    {
      label: "Cursor agent CLI",
      check: () => {
        try { execSync("which agent", { stdio: "pipe" }); return true; } catch { return false; }
      },
      autoCmd: "curl https://cursor.com/install -fsS | bash",
      manualCmd: "curl https://cursor.com/install -fsS | bash",
      successMsg: "Cursor CLI found",
    },
    {
      label: "Cursor API key",
      check: () => !!resolveCursorAgentToken(),
      autoCmd: "",
      manualCmd: "",
      successMsg: "Cursor API key configured",
    },
    {
      label: "cursor-composer-in-claude (bundled dependency)",
      check: () => tryBundledComposerHelp(),
      autoCmd: "npm install",
      manualCmd: "npm install",
      successMsg: "Bundled proxy package installed",
    },
  ];
}

const CURSOR_KEY_PROVIDER_ID = "cursor";

/** Persist the Cursor API key into providers.json. */
function saveCursorApiKey(key: string): void {
  const existing = loadProviders().filter(p => p.cursorProxy);
  if (existing.length > 0) {
    const p = existing[0];
    p.cursorApiKey = key;
    saveProvider(p);
    return;
  }
  saveProvider({
    id: CURSOR_KEY_PROVIDER_ID,
    displayName: "Cursor (API key)",
    baseURL: PROXY_DEFAULT_URL,
    model: "auto",
    cursorProxy: true,
    cursorApiKey: key,
  });
}

async function promptAndSaveCursorKey(): Promise<boolean> {
  console.log(chalk.dim(`  Get your API key from https://cursor.com/dashboard/integrations`));
  console.log(chalk.dim(`  (Scroll to the "API Keys" section at the bottom of the page)\n`));
  const key = await ask(`  ${chalk.cyan("API key")}: `);
  const trimmed = key?.trim();
  if (!trimmed) {
    console.log(chalk.yellow("  No key provided — skipped"));
    return false;
  }
  process.env.CURSOR_BRIDGE_API_KEY = trimmed;
  saveCursorApiKey(trimmed);
  return true;
}

/**
 * Full install + configure flow for cursor-composer-in-claude.
 * Only needed when quick auto-start fails.
 */
export async function setupCursorProxy(): Promise<boolean> {
  console.log(chalk.dim("\n  Configure cursor-composer-in-claude"));
  console.log(chalk.dim("  " + "─".repeat(40)));
  console.log(chalk.dim("  We need three things: Cursor CLI, an API key, and the proxy server.\n"));

  const steps = setupSteps();

  const cliStep = steps[0];
  if (cliStep.check()) {
    console.log(chalk.green(`  ✓ ${cliStep.successMsg}`));
  } else {
    console.log(chalk.yellow(`\n  ${cliStep.label} not found`));
    const choice = await selectKey(`  Install ${cliStep.label}?`, [
      { key: "a", desc: "uto (run command)" },
      { key: "m", desc: "anual (show command)" },
      { key: "s", desc: "kip (I'll handle it)" },
    ]);
    if (choice === "a") {
      console.log(chalk.dim(`  Running: ${cliStep.autoCmd}`));
      try {
        execSync(cliStep.autoCmd, { stdio: "inherit", timeout: 60_000 });
        console.log(chalk.green(`  ✓ ${cliStep.successMsg}`));
      } catch {
        console.log(chalk.yellow("  Command failed — try manual mode"));
      }
    } else if (choice === "m") {
      console.log(chalk.cyan(`\n  Run this command:`));
      console.log(chalk.white(`    ${cliStep.manualCmd}\n`));
    } else {
      console.log(chalk.dim(`  Skipped: ${cliStep.label}`));
    }
  }

  const keyStep = steps[1];
  if (keyStep.check()) {
    console.log(chalk.green(`  ✓ ${keyStep.successMsg}`));
  } else {
    console.log(chalk.yellow(`\n  ${keyStep.label} not configured`));
    console.log(chalk.cyan(`  1. Open: https://cursor.com/dashboard/integrations`));
    console.log(chalk.cyan(`  2. Scroll to "API Keys" at the bottom of the page`));
    console.log(chalk.cyan(`  3. Copy your API key and paste it below\n`));
    if (await promptAndSaveCursorKey()) {
      console.log(chalk.green(`  ✓ ${keyStep.successMsg}`));
    } else {
      console.log(chalk.yellow("  No API key — the proxy won't authenticate without one."));
    }
  }

  const proxyStep = steps[2];
  const installRoot = getClaudeOvernightInstallRoot();
  if (proxyStep.check()) {
    console.log(chalk.green(`  ✓ ${proxyStep.successMsg}`));
  } else {
    console.log(chalk.yellow(`\n  ${proxyStep.label} missing under node_modules`));
    const choice = await selectKey(`  Run npm install in this claude-overnight install?`, [
      { key: "a", desc: "uto (npm install)" },
      { key: "m", desc: "anual (show commands)" },
      { key: "s", desc: "kip (I'll handle it)" },
    ]);
    if (choice === "a") {
      console.log(chalk.dim(`  Running: npm install in ${installRoot}`));
      try {
        execSync("npm install", { cwd: installRoot, stdio: "inherit", timeout: 180_000 });
      } catch {
        console.log(chalk.yellow("  npm install failed."));
        return false;
      }
      if (!tryBundledComposerHelp()) {
        console.log(chalk.yellow("  cursor-composer-in-claude still missing after npm install."));
        return false;
      }
      console.log(chalk.green(`  ✓ ${proxyStep.successMsg}`));
    } else if (choice === "m") {
      console.log(chalk.cyan(`\n  From ${chalk.bold(installRoot)}:`));
      console.log(chalk.white(`    ${chalk.bold("npm install")}`));
      const cmd = bundledComposerProxyShellCommand();
      if (cmd) console.log(chalk.white(`    ${chalk.bold(cmd)}\n`));
      const ok = await selectKey(`  Done?`, [
        { key: "r", desc: "eady" },
        { key: "c", desc: "ancel" },
      ]);
      if (ok === "c") return false;
    } else {
      console.log(chalk.dim(`  Skipped: ${proxyStep.label}`));
      return false;
    }
  }

  if (await ensureCursorProxyRunning()) return true;

  const manual = bundledComposerProxyShellCommand();
  console.log(chalk.yellow(`\n  Couldn't start the proxy automatically.`));
  console.log(chalk.cyan(`  Ensure dependencies: ${chalk.bold(`cd "${installRoot}" && npm install`)}`));
  if (manual) console.log(chalk.cyan(`  Start bundled proxy: ${chalk.bold(manual)}`));
  for (;;) {
    const choice = await selectKey(`  Proxy started?`, [
      { key: "r", desc: "etry (re-attempt auto-start + kill stale)" },
      { key: "c", desc: "ancel" },
    ]);
    if (choice !== "r") return false;
    if (await ensureCursorProxyRunning(PROXY_DEFAULT_URL, { forceRestart: true })) {
      console.log(chalk.green("\n  ✓ Proxy is running and healthy"));
      return true;
    }
    console.log(chalk.yellow(`  Still not reachable at ${PROXY_DEFAULT_URL}`));
  }
}

// ── Cursor model picker sub-flow ──

interface CursorPickerItem {
  id: string;
  name: string;
  hint: string;
}

async function buildCursorPicker(): Promise<{ top: CursorPickerItem[]; more: CursorPickerItem[] }> {
  const liveIds = await fetchLiveCursorModels();
  const extra = new Set<string>();
  for (const id of liveIds) {
    if (!KNOWN_CURSOR_MODEL_IDS.has(id)) extra.add(id);
  }

  const top: CursorPickerItem[] = [
    ...CURSOR_PRIORITY_MODELS.map(m => ({ id: m.id, name: m.label, hint: m.hint })),
    ...CURSOR_KNOWN_MODELS.map(m => ({ id: m.id, name: m.label, hint: m.hint })),
  ];

  const MORE_THRESHOLD = 6;
  const more: CursorPickerItem[] = [...extra].sort().map(id => ({
    id,
    name: id,
    hint: cursorModelHint(id),
  }));

  if (more.length <= MORE_THRESHOLD) {
    return { top: [...top, ...more], more: [] };
  }
  return { top, more };
}

export async function pickCursorModel(): Promise<ModelPick | null> {
  console.log(chalk.dim("\n  Cursor API Proxy Models"));
  console.log(chalk.dim("  " + "─".repeat(40)));

  let frame = 0;
  const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = setInterval(() => {
    process.stdout.write(`\x1B[2K\r  ${chalk.cyan(BRAILLE[frame++ % BRAILLE.length])} ${chalk.dim("checking proxy...")}`);
  }, 120);
  const healthy = await healthCheckCursorProxy();
  clearInterval(spinner);
  process.stdout.write("\x1B[2K\r");

  if (!healthy && !(await ensureCursorProxyRunning()) && !(await recoverCursorProxy())) return null;

  const { top, more } = await buildCursorPicker();

  const items: Array<{ name: string; value: string; hint?: string }> = top.map(m => ({
    name: m.name,
    value: m.id,
    hint: m.hint,
  }));

  if (more.length > 0) {
    items.push({ name: chalk.gray("more…"), value: "__more__", hint: `${more.length} additional models` });
  }

  const picked = await select("  Select a Cursor model:", items, 0);

  if (picked === "__more__") {
    const moreItems = more.map(m => ({ name: m.name, value: m.id, hint: m.hint }));
    return saveCursorPick(await select("  More Cursor models:", moreItems, 0));
  }

  return saveCursorPick(picked);
}

/** Interactive recovery loop after auto-start fails — retry, full setup, or cancel. */
async function recoverCursorProxy(): Promise<boolean> {
  console.log(chalk.yellow("  Proxy is not running at " + PROXY_DEFAULT_URL));
  for (;;) {
    const choice = await selectKey(`  How to proceed?`, [
      { key: "r", desc: "etry (re-attempt auto-start + kill stale)" },
      { key: "i", desc: "nstall + configure (CLI, API key, server)" },
      { key: "c", desc: "ancel" },
    ]);
    if (choice === "r") {
      if (await ensureCursorProxyRunning(PROXY_DEFAULT_URL, { forceRestart: true })) {
        console.log(chalk.green("  ✓ Proxy started"));
        return true;
      }
      console.log(chalk.yellow(`  Still not reachable at ${PROXY_DEFAULT_URL}`));
    } else if (choice === "i") {
      if (!(await setupCursorProxy())) return false;
      if (await healthCheckCursorProxy()) return true;
      return false;
    } else {
      return false;
    }
  }
}

function saveCursorPick(modelId: string): ModelPick {
  const existingKey = loadProviders().find(p => p.id === CURSOR_KEY_PROVIDER_ID)?.cursorApiKey;
  const provider: ProviderConfig = {
    id: `cursor-${modelId}`,
    displayName: `Cursor: ${modelId}`,
    baseURL: PROXY_DEFAULT_URL,
    model: modelId,
    cursorProxy: true,
    ...(existingKey ? { cursorApiKey: existingKey } : {}),
  };
  saveProvider(provider);
  console.log(chalk.green(`  ✓ Saved as provider: ${provider.displayName}`));
  return { model: modelId, providerId: provider.id, provider };
}
