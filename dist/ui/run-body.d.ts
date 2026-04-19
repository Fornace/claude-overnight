import React from "react";
import type { Swarm } from "../swarm/swarm.js";
import { type StreamViewMode } from "./widgets/stream-pane.js";
export declare function RunBody({ swarm, selectedAgentId, viewMode, onViewModeChange, }: {
    swarm: Swarm;
    selectedAgentId?: number;
    viewMode?: StreamViewMode;
    onViewModeChange?: (mode: StreamViewMode) => void;
}): React.ReactElement;
