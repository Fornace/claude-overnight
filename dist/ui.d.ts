import type { Swarm } from "./swarm.js";
export declare function renderFrame(swarm: Swarm): string;
export declare function startRenderLoop(swarm: Swarm): () => void;
