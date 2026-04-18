// Framework-agnostic UI state pub/sub.
//
// The Ink tree subscribes via `useSyncExternalStore` while RunDisplay pushes
// mutations through `patch()`. Keeping this React-free means the store can be
// unit-tested and any renderer (Ink, classic, tests) can sit on top of it.
export class UiStore {
    state;
    listeners = new Set();
    constructor(initial) {
        this.state = initial;
    }
    get = () => this.state;
    subscribe = (l) => {
        this.listeners.add(l);
        return () => { this.listeners.delete(l); };
    };
    patch = (patch) => {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners)
            l();
    };
    mutate = (fn) => {
        this.state = fn(this.state);
        for (const l of this.listeners)
            l();
    };
}
export function makeInitialState(runInfo, liveConfig, flags) {
    return {
        runInfo,
        liveConfig,
        phase: "run",
        steeringStatusLine: "Assessing...",
        steeringStartedAt: 0,
        steeringEvents: [],
        askBusy: false,
        askTempFileAvailable: false,
        debriefHistory: [],
        input: { mode: "none", buffer: "", settingsField: 0 },
        hasOnAsk: flags.hasOnAsk,
        hasOnSteer: flags.hasOnSteer,
        tick: 0,
    };
}
