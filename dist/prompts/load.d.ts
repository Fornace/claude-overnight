export declare const PROMPTS_ROOT: string;
export type PromptVars = Record<string, string | number | boolean | undefined | null>;
export interface RenderOpts {
    variant?: string;
    vars?: PromptVars;
}
export declare function renderPrompt(file: string, opts?: RenderOpts): string;
