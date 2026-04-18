export declare function attemptJsonParse(text: string): any | null;
export declare function extractTaskJson(raw: string, retry: () => Promise<string>, onLog?: (text: string) => void, outFile?: string): Promise<{
    tasks: any[];
}>;
