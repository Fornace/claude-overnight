import React from "react";
import type { UiStore, HostCallbacks } from "./store.js";
import { deleteWordBackward as rawDeleteWordBackward } from "./raw-input.js";
export declare const MAX_INPUT_LEN = 600;
export declare const CONTROL_CHAR_RE: RegExp;
/** Strip control characters from typed raw input. Exported for tests. */
export declare function sanitizeTyped(raw: string): string;
/** Delete the previous word including any trailing whitespace, readline-style.
 *  Exported for tests. */
export declare const deleteWordBackward: typeof rawDeleteWordBackward;
interface Props {
    store: UiStore;
    callbacks: HostCallbacks;
    onToast(msg: string): void;
}
export declare function InputLayer({ store, callbacks, onToast }: Props): React.ReactElement | null;
export {};
