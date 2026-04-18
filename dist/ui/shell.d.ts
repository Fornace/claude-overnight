import React from "react";
import type { UiStore, HostCallbacks } from "./store.js";
interface Props {
    store: UiStore;
    callbacks: HostCallbacks;
}
export declare function App({ store, callbacks }: Props): React.ReactElement;
export {};
