export declare function promptBudgetExtension(ctx: {
    estimate: number | undefined;
    spent: number;
    sessionsUsed: number;
    budget: number;
}): Promise<number>;
