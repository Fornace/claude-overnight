/**
 * Autonomous circuit breaker: halt after consecutive waves where no non-heal
 * task landed merged file changes *and* no agent used tools (true idle).
 *
 * If agents used tools but files stayed at 0, treat as possible worktree/merge
 * infrastructure issue — do not advance the halt streak.
 */
export function updateCircuitBreakerStreak(args) {
    const { waveNum, prevStreak, nonHealFiles, totalToolCallsAllAgents } = args;
    if (waveNum <= 0 || nonHealFiles > 0) {
        return { streak: 0, shouldHalt: false };
    }
    if (totalToolCallsAllAgents > 0) {
        return { streak: 0, shouldHalt: false };
    }
    const streak = prevStreak + 1;
    return { streak, shouldHalt: streak >= 2 };
}
