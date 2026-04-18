import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";

// JWT token lifecycle for claude-overnight.
// Agents carry short-lived tokens signed by a local secret instead of raw API keys.

export interface JWTPayload {
  sub: string;       // Provider id
  model: string;     // Model the token is scoped to
  bearer: string;    // Underlying API key
  aud: string;       // Endpoint base URL
  iat: number;       // Issued-at epoch seconds
  exp: number;       // Expiry epoch seconds
}

export interface TokenRecord {
  signedToken: string;
  payload: JWTPayload;
}

const SECRET_PATH = join(homedir(), ".claude", "claude-overnight", "jwt-secret.key");

export function loadSecret(): Buffer {
  try {
    const raw = readFileSync(SECRET_PATH);
    if (raw.length >= 32) return raw;
  } catch {}
  const secret = cryptoRandomBytes(32);
  mkdirSync(join(homedir(), ".claude", "claude-overnight"), { recursive: true });
  writeFileSync(SECRET_PATH, secret);
  try { chmodSync(SECRET_PATH, 0o600); } catch {}
  return secret;
}

function deriveKey(secret: Buffer, providerId: string): Buffer {
  const crypto = require("crypto");
  return crypto.createHmac("sha256", secret).update(providerId).digest();
}

const DEFAULT_TTL_SEC = 300; // 5 minutes

export function signToken(providerId: string, model: string, bearer: string, baseURL: string): TokenRecord {
  const jwt = require("jsonwebtoken");
  const secret = loadSecret();
  const key = deriveKey(secret, providerId);
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { sub: providerId, model, bearer, aud: baseURL, iat: now, exp: now + DEFAULT_TTL_SEC };
  const signedToken = jwt.sign(payload, key, { algorithm: "HS256" });
  return { signedToken, payload };
}

export function verifyToken(token: string, providerId: string): JWTPayload | null {
  const jwt = require("jsonwebtoken");
  const secret = loadSecret();
  const key = deriveKey(secret, providerId);
  try {
    return jwt.verify(token, key, { algorithms: ["HS256"] }) as JWTPayload;
  } catch {
    return null;
  }
}

export function refreshToken(oldToken: string, providerId: string): TokenRecord | null {
  const payload = verifyToken(oldToken, providerId);
  if (!payload) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp - now > 60) return null;
  return signToken(payload.sub, payload.model, payload.bearer, payload.aud);
}

const tokenCache = new Map<string, TokenRecord>();

export function getBearerToken(providerId: string, model: string, bearer: string, baseURL: string): string {
  const cached = tokenCache.get(providerId);
  if (cached) {
    const payload = verifyToken(cached.signedToken, providerId);
    if (payload && payload.exp > Math.floor(Date.now() / 1000) + 30) {
      return cached.signedToken;
    }
  }
  const fresh = refreshToken(cached?.signedToken ?? "", providerId) ?? signToken(providerId, model, bearer, baseURL);
  tokenCache.set(providerId, fresh);
  return fresh.signedToken;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

function cryptoRandomBytes(length: number): Buffer {
  const crypto = require("crypto");
  return crypto.randomBytes(length);
}

export function isJWTAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes("token expired") || lower.includes("invalid_token")
    || lower.includes("jwt") || lower.includes("signature")
    || lower.includes("unauthorized") || lower.includes("forbidden")
    || lower.includes("invalid_api_key") || lower.includes("authentication");
}
