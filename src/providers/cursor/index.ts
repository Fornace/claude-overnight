// Public surface of the cursor-composer-in-claude integration. Other code in
// the repo should import from here, not from ./env / ./proxy / ./picker.
export {
  PROXY_DEFAULT_URL,
  isCursorProxyProvider,
  bundledComposerProxyShellCommand,
  readCursorProxyLogTail,
  warnMacCursorAgentShellPatchIfNeeded,
  hasCursorAgentToken,
  getCursorAgentToken,
  resolveCursorAgentToken,
  cachedAgentPaths,
} from "./env.js";
export {
  healthCheckCursorProxy,
  ensureCursorProxyRunning,
  preflightCursorProxyViaHttp,
} from "./proxy.js";
export type { EnsureProxyOptions } from "./proxy.js";
export { pickCursorModel } from "./picker.js";
