import React from "react";
import type { AskState } from "./types.js";
interface Props {
    ask?: AskState;
    debrief?: {
        text: string;
        label?: string;
    };
}
export declare function Overlay({ ask, debrief }: Props): React.ReactElement | null;
export {};
