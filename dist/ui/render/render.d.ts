import type { Swarm } from "../../swarm/swarm.js";
import type { RunInfo } from "../ui.js";
import type { InteractivePanel } from "../interactive-panel.js";
export { fmtDur, fmtTokens, renderWaitingIndicator, spinnerFrame, truncate, wrap, } from "./primitives.js";
export { type ContentRenderer, type Section, renderUnifiedFrame } from "./layout.js";
export { contextFillInfo } from "./bars.js";
export { renderSteeringFrame, type SteeringViewData } from "./steering.js";
export declare function renderFrame(swarm: Swarm, showHotkeys: boolean, runInfo?: RunInfo, selectedAgentId?: number, maxRows?: number, panel?: InteractivePanel): string;
export declare function renderSummary(swarm: Swarm): string;
