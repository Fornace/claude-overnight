import React from "react";
import type { UiStore, HostCallbacks } from "./store.js";
export declare const MAX_INPUT_LEN = 600;
interface Props {
    store: UiStore;
    callbacks: HostCallbacks;
    onToast(msg: string): void;
}
export declare function InputLayer({ store, callbacks, onToast }: Props): React.ReactElement | null;
export {};
