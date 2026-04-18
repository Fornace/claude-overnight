import type { RateLimitWindow } from "../core/types.js";

export interface PlannerRateLimitInfo {
  utilization: number;
  status: string;
  isUsingOverage: boolean;
  windows: Map<string, RateLimitWindow>;
  resetsAt?: number;
  costUsd: number;
  /** Total input tokens (input + cache) from the most recent planner turn — proxy for context-window occupancy. */
  contextTokens?: number;
  /** Model used by the current planner query (for safeContext lookup). */
  model?: string;
}

/**
 * Logging callback used by planner/steering queries.
 * `kind` distinguishes ephemeral status updates (heartbeat ticker) from
 * discrete events worth persisting in a scrollback log (tool uses, retries).
 */
export type PlannerLog = (text: string, kind?: "status" | "event") => void;

const RATE_LIMIT_PATTERNS = ["rate", "limit", "overloaded", "429", "hit your limit", "too many"];

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_PATTERNS.some((p) => msg.toLowerCase().includes(p));
}

let _totalPlannerCostUsd = 0;
export function getTotalPlannerCost(): number { return _totalPlannerCostUsd; }
export function addPlannerCost(costUsd: number): void {
  _totalPlannerCostUsd += costUsd;
  _info.costUsd += costUsd;
}

let _peakTokens = 0;
let _peakModel: string | undefined;
export function getPeakPlannerContext(): { tokens: number; model?: string } {
  return { tokens: _peakTokens, model: _peakModel };
}
export function recordPeakContext(tokens: number, model: string): void {
  if (tokens > _peakTokens) { _peakTokens = tokens; _peakModel = model; }
}

const _info: PlannerRateLimitInfo = {
  utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0,
};

export function getPlannerRateLimitInfo(): PlannerRateLimitInfo { return _info; }

export function resetPlannerRateLimit(model: string): void {
  _info.utilization = 0;
  _info.status = "";
  _info.isUsingOverage = false;
  _info.windows = new Map();
  _info.costUsd = 0;
  _info.contextTokens = 0;
  _info.model = model;
  _info.resetsAt = undefined;
}

export function setContextTokens(n: number): void { _info.contextTokens = n; }

export function applyRateLimitEvent(info: {
  utilization?: number;
  status?: string;
  isUsingOverage?: boolean;
  resetsAt?: number;
  rateLimitType?: string;
}): void {
  _info.utilization = info.utilization ?? 0;
  _info.status = info.status ?? "";
  if (info.isUsingOverage) _info.isUsingOverage = true;
  if (info.resetsAt) _info.resetsAt = info.resetsAt;
  if (info.rateLimitType) {
    _info.windows.set(info.rateLimitType, {
      type: info.rateLimitType,
      utilization: info.utilization ?? 0,
      status: info.status ?? "",
      resetsAt: info.resetsAt,
    });
  }
}

/**
 * Proactive rate-limit gate. Called before each planner/steering query to
 * prevent hammering the API when we're already near a limit.
 *
 * Levels:
 *   - rejected -> wait until resetsAt (or 60s fallback)
 *   - utilization >= 90% -> wait 30s with exponential backoff
 *   - utilization >= 75% -> brief 5s cooldown
 *   - utilization < 75% -> pass through immediately
 */
export async function throttlePlanner(
  onLog: PlannerLog,
  aborted: () => boolean,
): Promise<void> {
  const MAX_BACKOFF = 3;
  for (let backoff = 0; backoff <= MAX_BACKOFF; backoff++) {
    if (aborted()) return;
    const rejected = _info.resetsAt && _info.resetsAt > Date.now();
    const highUtil = _info.utilization >= 0.9;
    const elevatedUtil = _info.utilization >= 0.75;
    if (!rejected && !highUtil && !elevatedUtil) return;

    const waitMs = rejected
      ? Math.max(5000, _info.resetsAt! - Date.now())
      : highUtil ? 30_000 * (1 + backoff) : 5000;

    const reason = rejected ? "Rate limited" : `Utilization ${Math.round(_info.utilization * 100)}%`;
    onLog(`${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s before query${backoff > 0 ? ` (backoff ${backoff})` : ""}`, "event");
    await new Promise((r) => setTimeout(r, waitMs));

    if (aborted()) return;
    if (rejected && _info.resetsAt && _info.resetsAt <= Date.now()) {
      _info.resetsAt = undefined;
      _info.utilization = 0;
    }
  }
}
