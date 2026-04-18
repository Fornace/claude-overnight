// ── Pre-wave rate limit gate ──
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
/**
 * Proactive rate-limit gate called before spawning a new wave. Prevents
 * starting a batch of agents when the API is already near or at a limit,
 * which would waste sessions on instant rejections.
 *
 * Thresholds:
 *   - any window rejected → wait until resetsAt (or 60s fallback)
 *   - utilization >= 90% → wait 60s
 *   - utilization >= 75% → wait 15s
 */
export async function throttleBeforeWave(getRL, log, shouldStop) {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (shouldStop())
            return;
        const rl = getRL();
        // Check for rejected windows
        let rejectedReset;
        for (const w of rl.windows.values()) {
            if (w.status === "rejected" && w.resetsAt && w.resetsAt > Date.now()) {
                if (!rejectedReset || w.resetsAt < rejectedReset)
                    rejectedReset = w.resetsAt;
            }
        }
        const highUtil = rl.utilization >= 0.9;
        const elevatedUtil = rl.utilization >= 0.75;
        const explicitRejected = rl.resetsAt && rl.resetsAt > Date.now();
        if (!rejectedReset && !explicitRejected && !highUtil && !elevatedUtil)
            return;
        const waitMs = rejectedReset
            ? Math.max(10_000, rejectedReset - Date.now())
            : explicitRejected
                ? Math.max(10_000, rl.resetsAt - Date.now())
                : highUtil
                    ? 60_000 * (1 + attempt)
                    : 15_000;
        const reason = rejectedReset ? `Rate limit window blocked`
            : explicitRejected ? "Rate limited"
                : `Utilization ${Math.round(rl.utilization * 100)}%`;
        log(`${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s before wave${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);
        await sleep(waitMs);
    }
    // Exhausted attempts — proceed anyway, swarm's internal retry will handle rejections.
}
