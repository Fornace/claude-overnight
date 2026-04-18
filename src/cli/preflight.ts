import chalk from "chalk";
import { getProxyPort, buildProxyUrl } from "../core/proxy-port.js";
import { setPlannerEnvResolver } from "../planner/query.js";
import {
  preflightProvider,
  isCursorProxyProvider,
  readCursorProxyLogTail,
  ensureCursorProxyRunning,
  bundledComposerProxyShellCommand,
  hasCursorAgentToken,
  PROXY_DEFAULT_URL,
  buildEnvResolver,
} from "../providers/index.js";
import type { ProviderConfig } from "../providers/index.js";

export interface PreflightInput {
  plannerModel: string;
  plannerProvider?: ProviderConfig | undefined;
  workerModel: string;
  workerProvider?: ProviderConfig | undefined;
  fastModel?: string | undefined;
  fastProvider?: ProviderConfig | undefined;
  cwd: string;
}

export interface PreflightResult {
  /** true when the fast provider failed preflight and the caller should drop it */
  fastDegraded: boolean;
}

export async function runProviderPreflight(input: PreflightInput): Promise<PreflightResult> {
  const { plannerModel, plannerProvider, workerModel, workerProvider, fastProvider, cwd } = input;

  const seen = new Set<string>();
  const all: Array<[string, ProviderConfig | undefined]> = [
    ["planner", plannerProvider],
    ["worker", workerProvider],
    ["fast", fastProvider],
  ];
  const pending: Array<[string, ProviderConfig]> = [];
  const cursorProxies: ProviderConfig[] = [];
  for (const [role, p] of all) {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      pending.push([role, p]);
      if (isCursorProxyProvider(p)) cursorProxies.push(p);
    }
  }

  // Auto-start cursor proxy before pinging (restarts when a token exists so stale listeners get CURSOR_API_KEY).
  if (cursorProxies.length > 0) {
    const resolvedPort = getProxyPort(cwd);
    const resolvedUrl = buildProxyUrl(resolvedPort);
    await ensureCursorProxyRunning(resolvedUrl);
    // Sync providers to the resolved port (may differ from default if per-project port was picked)
    for (const p of cursorProxies) {
      if (!p.baseURL || p.baseURL === PROXY_DEFAULT_URL) {
        p.baseURL = resolvedUrl;
      }
    }
    if (resolvedUrl !== PROXY_DEFAULT_URL) {
      console.log(chalk.dim(`  Proxy port: ${resolvedPort}`));
    }
    if (!hasCursorAgentToken()) {
      console.error(chalk.red(
        `  ✗ Cursor models require a User API key — add it via ${chalk.bold("Cursor…")} setup, or set ` +
        `${chalk.bold("CURSOR_API_KEY")} / ${chalk.bold("CURSOR_BRIDGE_API_KEY")}, or ${chalk.bold("cursorApiKey")} in providers.json.`,
      ));
      console.error(chalk.dim(`    Without it the Cursor CLI falls back to macOS Keychain (\`cursor-user\`).`));
      process.exit(1);
    }
  }

  process.stdout.write(`  ${chalk.dim(`◆ Pinging ${pending.map(([r, p]) => `${r} (${p.displayName})`).join(", ")}…`)}\n`);
  // Preflight strategy: all providers run fully in parallel. Cursor proxy
  // providers used to race on the shared `~/.cursor/cli-config.json`, but the
  // proxy now uses an account pool (`CURSOR_CONFIG_DIRS`) — each parallel
  // cursor-agent subprocess gets its own config dir, eliminating the race.
  // See ensureCursorAccountPool() in providers.ts.
  //
  // Single in-place status line collapses N parallel progress streams (one
  // per provider) into one tty line updated via `\r` + ANSI clear. Keeps the
  // "window head" calm instead of appending 3 lines per 3s tick.
  const statuses = new Map<string, string>();
  const isTTY = process.stdout.isTTY;
  let statusLineActive = false;
  const renderStatus = () => {
    if (!isTTY) return;
    const parts = [...statuses.entries()].map(([r, s]) => `${r} ${chalk.dim(s)}`);
    process.stdout.write(`\x1B[2K\r`);
    if (parts.length === 0) { statusLineActive = false; return; }
    process.stdout.write(chalk.dim("    " + parts.join("  ·  ")));
    statusLineActive = true;
  };
  const clearStatusLine = () => {
    if (isTTY && statusLineActive) { process.stdout.write(`\x1B[2K\r`); statusLineActive = false; }
  };
  /** Cursor agent cold start + thinking-variant model latency can exceed 20s, and the cursor
   *  preflight now also runs a write-capability probe (see probeCursorWriteCapability) that
   *  asks cursor to Bash a marker file — so the total budget must cover auth ping + write turn. */
  const preflightMs = (p: ProviderConfig) =>
    isCursorProxyProvider(p) ? 90_000 : 20_000;
  // Cursor's composer-2 pipeline intermittently stalls for 100s+ on a write-tool turn
  // even though the tool succeeded (proxy logs it as "SLOW response"). A single retry
  // almost always clears it — so we retry once on timeout-style failures for cursor
  // proxy providers before giving up.
  const isTimeoutError = (err: string) => /^timeout after /.test(err) || /: timeout after /.test(err);
  const runPreflight = async (role: string, p: ProviderConfig) => {
    statuses.set(role, "connecting…");
    renderStatus();
    let result = await preflightProvider(p, cwd, preflightMs(p), {
      onProgress: (msg) => { statuses.set(role, msg); renderStatus(); },
    });
    if (!result.ok && isCursorProxyProvider(p) && isTimeoutError(result.error)) {
      statuses.set(role, "retrying after timeout…");
      renderStatus();
      result = await preflightProvider(p, cwd, preflightMs(p), {
        onProgress: (msg) => { statuses.set(role, `retry: ${msg}`); renderStatus(); },
      });
    }
    statuses.delete(role);
    renderStatus();
    return { role, provider: p, result };
  };
  const results = await Promise.all(pending.map(([role, p]) => runPreflight(role, p)));
  clearStatusLine();
  let fastDegraded = false;
  for (const { role, provider, result } of results) {
    if (!result.ok) {
      const degradable = role === "fast";
      const prefix = degradable ? chalk.yellow(`  ⚠ ${role} preflight failed`) : chalk.red(`  ✗ ${role} preflight failed`);
      console.error(`${prefix}: ${chalk.dim(result.error)}`);
      if (isCursorProxyProvider(provider)) {
        const tail = readCursorProxyLogTail(25);
        if (tail) {
          console.error(chalk.yellow(`  ── proxy log tail (agent stderr + sessions) ──`));
          for (const line of tail.split("\n")) console.error(chalk.dim(`    ${line}`));
        }
        const cmd = bundledComposerProxyShellCommand();
        const proxyUrl = provider.baseURL || PROXY_DEFAULT_URL;
        console.error(chalk.yellow(
          `  The proxy at ${proxyUrl} may have crashed or timed out (e.g. keychain/UI). Retry, or start the bundled proxy: ${cmd ?? "npm install in the claude-overnight package, then re-run"}`,
        ));
      } else if (!degradable) {
        console.error(chalk.red(`  Fix the provider at ~/.claude/claude-overnight/providers.json and retry.`));
      }
      if (degradable) {
        console.error(chalk.yellow(`  Continuing without the fast worker — fast-eligible tasks will run on the main worker model instead.`));
        console.error("");
        fastDegraded = true;
        continue;
      }
      console.error("");
      process.exit(1);
    }
    console.log(`  ${chalk.green(`✓ ${role} ready`)} ${chalk.dim(`· ${provider.displayName} · ${provider.model}`)}`);
  }
  if (fastDegraded) {
    const rebuilt = buildEnvResolver({ plannerModel, plannerProvider, workerModel, workerProvider, fastModel: undefined, fastProvider: undefined });
    setPlannerEnvResolver(rebuilt);
  }
  return { fastDegraded };
}
