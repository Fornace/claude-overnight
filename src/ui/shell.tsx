// The App root. One persistent Shell — Header / Body / Footer — swaps only the
// body based on phase. Header ticks once per second (so elapsed never freezes)
// regardless of what the body is doing.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box } from "ink";
import type { UiStore, HostCallbacks } from "./store.js";
import { Header } from "./header.js";
import { Footer } from "./footer.js";
import { RunBody } from "./run-body.js";
import { SteeringBody } from "./steering-body.js";
import { Overlay } from "./overlay.js";
import { InputLayer } from "./input.js";

interface Props {
  store: UiStore;
  callbacks: HostCallbacks;
}

export function App({ store, callbacks }: Props): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [toast, setToast] = useState<string | undefined>();

  useEffect(() => {
    const id = setInterval(() => {
      store.patch({ tick: store.get().tick + 1 });
    }, 1000);
    return () => clearInterval(id);
  }, [store]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(undefined), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  const showToast = (msg: string): void => setToast(msg);

  return (
    <Box flexDirection="column">
      <Header
        phase={state.phase}
        runInfo={state.runInfo}
        swarm={state.swarm}
        rlGetter={state.rlGetter}
        selectedAgentId={state.selectedAgentId}
      />
      {state.phase === "run" && state.swarm
        ? <RunBody swarm={state.swarm} selectedAgentId={state.selectedAgentId} />
        : null}
      {state.phase === "steering"
        ? <SteeringBody
            runInfo={state.runInfo}
            context={state.steeringContext}
            events={state.steeringEvents}
            startedAt={state.steeringStartedAt}
            statusLine={state.steeringStatusLine}
            rlGetter={state.rlGetter}
          />
        : null}
      <Overlay ask={state.ask} debrief={state.debrief} />
      <InputLayer store={store} callbacks={callbacks} onToast={showToast} />
      <Footer state={state} toast={toast} />
    </Box>
  );
}
