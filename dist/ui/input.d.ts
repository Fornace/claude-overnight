import React from "react";
import type { UiStore, HostCallbacks } from "./store.js";
export declare const MAX_INPUT_LEN = 600;
export declare const CONTROL_CHAR_RE: RegExp;
/** Strip control characters from typed raw input so escape flushes, newlines,
 *  and C1 bytes never end up in the user's buffer. Exported for tests. */
export declare function sanitizeTyped(raw: string): string;
/** Delete the previous word including any trailing whitespace, readline-style.
 *  Bound to Ctrl+W and Opt/Cmd+Backspace. Exported for tests. */
export declare function deleteWordBackward(s: string): string;
interface Props {
    store: UiStore;
    callbacks: HostCallbacks;
    onToast(msg: string): void;
}
export declare function InputLayer({ store, callbacks, onToast }: Props): React.ReactElement | null;
export {};
