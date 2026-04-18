/**
 * Store a raw API key for a provider.
 * The key is kept in memory and persisted to disk (mode 0600).
 */
export declare function storeKey(providerId: string, key: string): void;
/** Retrieve a raw API key by provider ID, or null if not found. */
export declare function getKey(providerId: string): string | null;
/** Remove a key from the vault. Returns true if it existed. */
export declare function deleteKey(providerId: string): boolean;
/** Clear the entire vault (memory + disk). */
export declare function clearVault(): void;
