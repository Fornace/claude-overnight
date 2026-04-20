export interface CandidateInput {
    kind: "skill" | "tool-recipe" | "heuristic";
    proposedBy: string;
    wave: number;
    runId: string;
    fingerprint: string;
    trigger: string;
    body: string;
}
export declare function writeCandidate(input: CandidateInput): {
    wrote: boolean;
    dropped: boolean;
};
export { computeRepoFingerprint } from "../core/fingerprint.js";
