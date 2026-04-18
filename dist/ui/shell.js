import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// The App root. One persistent Shell — Header / Body / Footer — swaps only the
// body based on phase. Header ticks once per second (so elapsed never freezes)
// regardless of what the body is doing.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Box } from "ink";
import { Header } from "./header.js";
import { Footer } from "./footer.js";
import { RunBody } from "./run-body.js";
import { SteeringBody } from "./steering-body.js";
import { Overlay } from "./overlay.js";
import { InputLayer } from "./input.js";
export function App({ store, callbacks }) {
    const state = useSyncExternalStore(store.subscribe, store.get, store.get);
    const [toast, setToast] = useState();
    useEffect(() => {
        const id = setInterval(() => {
            store.patch({ tick: store.get().tick + 1 });
        }, 1000);
        return () => clearInterval(id);
    }, [store]);
    useEffect(() => {
        if (!toast)
            return;
        const id = setTimeout(() => setToast(undefined), 2500);
        return () => clearTimeout(id);
    }, [toast]);
    const showToast = (msg) => setToast(msg);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Header, { phase: state.phase, runInfo: state.runInfo, swarm: state.swarm, rlGetter: state.rlGetter, selectedAgentId: state.selectedAgentId }), state.phase === "run" && state.swarm
                ? _jsx(RunBody, { swarm: state.swarm, selectedAgentId: state.selectedAgentId })
                : null, state.phase === "steering"
                ? _jsx(SteeringBody, { runInfo: state.runInfo, context: state.steeringContext, events: state.steeringEvents, startedAt: state.steeringStartedAt, statusLine: state.steeringStatusLine, rlGetter: state.rlGetter })
                : null, _jsx(Overlay, { ask: state.ask, debrief: state.debrief }), _jsx(InputLayer, { store: store, callbacks: callbacks, onToast: showToast }), _jsx(Footer, { state: state, toast: toast })] }));
}
