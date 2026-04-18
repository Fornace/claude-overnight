// Pure mapper: (phase, state, flags) → Action[].
//
// The footer contract (HANDOFF.md "Action bar"): stable silhouette, fixed slot
// order, three visible states (enabled / disabled:context / disabled:notready).
// Dim keys never hide — pressing one surfaces its `reason` as a toast.
//
// This module must stay pure: no I/O, no mutation. It is the single source of
// truth for what the footer shows, and easy to unit-test.
export function deriveFooter(state) {
    const { phase, swarm, hasOnAsk, hasOnSteer, askBusy, debrief, ask } = state;
    const inOverlay = state.input.mode !== "none";
    // 1 — Ask
    const askAction = (() => {
        const slot = 1, id = "ask", key = "?", label = "Ask";
        if (!hasOnAsk)
            return { id, key, label, slot, state: "disabled:notready", reason: "Ask not wired for this run" };
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context", reason: "Finish the current input first" };
        if (askBusy || ask?.streaming)
            return { id, key, label, slot, state: "disabled:context", reason: "Ask already in flight" };
        return { id, key, label, slot, state: "enabled" };
    })();
    // 2 — Steer
    const steerAction = (() => {
        const slot = 2, id = "steer", key = "i", label = "Steer";
        if (!hasOnSteer)
            return { id, key, label, slot, state: "disabled:notready", reason: "Steering not wired for this run" };
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context", reason: "Finish the current input first" };
        return { id, key, label, slot, state: "enabled" };
    })();
    // 3 — Debrief (surfaces the latest debrief entry in the overlay)
    const debriefAction = (() => {
        const slot = 3, id = "debrief", key = "d", label = "Debrief";
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context" };
        if (!debrief && state.debriefHistory.length === 0) {
            return { id, key, label, slot, state: "disabled:context", reason: "No debrief yet" };
        }
        return { id, key, label, slot, state: "enabled" };
    })();
    // 4 — Pause / Resume
    const pauseAction = (() => {
        const slot = 4, id = "pause", key = "p";
        const paused = swarm?.paused === true;
        const label = paused ? "Resume" : "Pause";
        if (phase === "steering" || !swarm) {
            return { id, key, label, slot, state: "disabled:context", reason: "No live wave to pause" };
        }
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context" };
        return { id, key, label, slot, state: "enabled" };
    })();
    // 5 — Settings
    const settingsAction = (() => {
        const slot = 5, id = "settings", key = "s", label = "Settings";
        if (!state.liveConfig)
            return { id, key, label, slot, state: "disabled:notready" };
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context" };
        return { id, key, label, slot, state: "enabled" };
    })();
    // 6 — Fallback (requeue failed agents into the running pool)
    const fallbackAction = (() => {
        const slot = 6, id = "fallback", key = "f", label = "Fallback";
        if (phase === "steering" || !swarm)
            return { id, key, label, slot, state: "disabled:context", reason: "No failed branches to fall back from" };
        if (swarm.failed <= 0)
            return { id, key, label, slot, state: "disabled:context", reason: "No failed branches to fall back from" };
        if (swarm.active <= 0)
            return { id, key, label, slot, state: "disabled:context", reason: "No active workers to re-run failures" };
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context" };
        return { id, key, label, slot, state: "enabled" };
    })();
    // 7 — Skip rate-limit
    const skipRlAction = (() => {
        const slot = 7, id = "skip-rl", key = "r", label = "Skip RL";
        if (!swarm || swarm.rateLimitPaused <= 0)
            return { id, key, label, slot, state: "disabled:context", reason: "Not paused for rate-limit" };
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context" };
        return { id, key, label, slot, state: "enabled" };
    })();
    // 8 — Quit
    const quitAction = (() => {
        const slot = 8, id = "quit", key = "q", label = "Quit";
        if (inOverlay)
            return { id, key, label, slot, state: "disabled:context" };
        return { id, key, label, slot, state: "enabled" };
    })();
    return [askAction, steerAction, debriefAction, pauseAction, settingsAction, fallbackAction, skipRlAction, quitAction];
}
