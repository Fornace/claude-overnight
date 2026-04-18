export interface ThrottleRLInfo {
    utilization: number;
    windows: Map<string, {
        type: string;
        utilization: number;
        status: string;
        resetsAt?: number;
    }>;
    resetsAt?: number;
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
export declare function throttleBeforeWave(getRL: () => ThrottleRLInfo, log: (text: string) => void, shouldStop: () => boolean): Promise<void>;
