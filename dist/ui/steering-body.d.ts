import React from "react";
import type { RLGetter } from "../core/types.js";
import type { SteeringContext, SteeringEvent, RunInfo } from "./types.js";
interface Props {
    runInfo: RunInfo;
    context?: SteeringContext;
    events: SteeringEvent[];
    startedAt: number;
    statusLine: string;
    rlGetter?: RLGetter;
}
export declare function SteeringBody({ runInfo, context, events, startedAt, statusLine, rlGetter }: Props): React.ReactElement;
export {};
