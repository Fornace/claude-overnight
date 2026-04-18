/**
 * Load the HMAC signing secret from disk, or generate a new 32-byte one.
 */
export declare function loadSecret(): Buffer;
/** Derive a per-provider HMAC key from the master secret (cached). */
export declare function deriveKey(providerId: string): Buffer;
/** Clear in-memory secret and key caches. */
export declare function resetSecretCache(): void;
