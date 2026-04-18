import React from "react";
import type { Swarm } from "../swarm/swarm.js";
import type { RLGetter } from "../core/types.js";
import type { RunInfo } from "./types.js";
import type { Phase } from "./store.js";
interface Props {
    phase: Phase;
    runInfo: RunInfo;
    swarm?: Swarm;
    rlGetter?: RLGetter;
    selectedAgentId?: number;
}
export declare function Header({ phase, runInfo, swarm, rlGetter, selectedAgentId }: Props): React.ReactElement;
export {};
