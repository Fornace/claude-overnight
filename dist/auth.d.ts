export interface JWTPayload {
    sub: string;
    model: string;
    bearer: string;
    aud: string;
    iat: number;
    exp: number;
}
export interface TokenRecord {
    signedToken: string;
    payload: JWTPayload;
}
export declare function loadSecret(): Buffer;
export declare function signToken(providerId: string, model: string, bearer: string, baseURL: string): TokenRecord;
export declare function verifyToken(token: string, providerId: string): JWTPayload | null;
export declare function refreshToken(oldToken: string, providerId: string): TokenRecord | null;
export declare function getBearerToken(providerId: string, model: string, bearer: string, baseURL: string): string;
export declare function clearTokenCache(): void;
export declare function isJWTAuthError(err: unknown): boolean;
