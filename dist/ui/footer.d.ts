import React from "react";
import type { UiState } from "./store.js";
import type { RunInfo } from "./types.js";
interface Props {
    state: UiState;
    toast?: string;
}
export declare function Footer({ state, toast }: Props): React.ReactElement;
/** Used only for tests / introspection. */
export declare function __deriveFooterForRunInfo(_runInfo: RunInfo): void;
export {};
