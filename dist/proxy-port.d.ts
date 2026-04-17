/** Resolve proxy port (reads from config, or allocates and persists a new one). */
export declare function getProxyPort(projectRoot: string): number;
/** Build the full proxy URL for a per-project port. */
export declare function buildProxyUrl(port: number): string;
