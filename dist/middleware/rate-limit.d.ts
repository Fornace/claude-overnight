export interface RateLimitOptions {
    /** Max requests allowed in the window. */
    maxRequests: number;
    /** Window size in milliseconds. */
    windowMs: number;
    /** How to derive the rate-limit key from the request. Defaults to remote address. */
    keyFn?: (req: IncomingRequest) => string;
    /** Custom response body when rate limited. */
    message?: string | ((info: RateLimitInfo) => string);
    /** Custom status code. Defaults to 429. */
    statusCode?: number;
}
export interface IncomingRequest {
    remoteAddress?: string;
    headers: Record<string, string | string[] | undefined>;
}
export interface RateLimitInfo {
    /** The key used for this request. */
    key: string;
    /** Number of requests in the current window (including this one). */
    current: number;
    /** Max requests allowed. */
    limit: number;
    /** When the current window resets (ms epoch). */
    resetAt: number;
}
export declare function rateLimit(opts: RateLimitOptions): (req: IncomingRequest, next: (info?: {
    status: number;
    headers: Record<string, string>;
    body: string;
}) => void) => void;
/** Rate limit: 30 requests per minute per IP. Suitable for general API endpoints. */
export declare const apiRateLimit: (req: IncomingRequest, next: (info?: {
    status: number;
    headers: Record<string, string>;
    body: string;
}) => void) => void;
/** Rate limit: 10 requests per minute per IP. Stricter limit for expensive operations. */
export declare const strictRateLimit: (req: IncomingRequest, next: (info?: {
    status: number;
    headers: Record<string, string>;
    body: string;
}) => void) => void;
/** Rate limit: 5 requests per 10 seconds per IP. Burst protection for health checks. */
export declare const healthRateLimit: (req: IncomingRequest, next: (info?: {
    status: number;
    headers: Record<string, string>;
    body: string;
}) => void) => void;
