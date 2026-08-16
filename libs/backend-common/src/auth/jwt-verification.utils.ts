import { readFileSync } from 'fs';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JwtVerifyOptions } from '@nestjs/jwt';

/**
 * @module JwtVerificationUtils
 *
 * Centralised JWT verification options for the entire platform.
 *
 * WHY THIS EXISTS:
 * JWT verification options (algorithms, issuer, audience) were previously
 * specified inline at each guard call site. Guards that omitted `algorithms`
 * were vulnerable to algorithm confusion attacks (RS256/none downgrade).
 * Guards with conditional `if (payload.iss && ...)` checks silently accepted
 * tokens without issuer claims — a forged token could bypass validation.
 *
 * This utility is the single source of truth. Every guard MUST call
 * `getJwtVerifyOptions(configService)` and spread the result into
 * `jwtService.verifyAsync()`. Forgetting to do so causes a compile-time
 * type error (missing verification key) rather than a silent security gap.
 *
 * SECURITY: RS256 asymmetric signing (CRITICAL-001 fix)
 * =====================================================
 * The platform previously used HS256 with a shared JWT_SECRET distributed to
 * every service. Any compromised service could forge valid tokens for the
 * entire platform. Now:
 *   - auth-service is the SOLE token issuer (signs with JWT_PRIVATE_KEY, RS256)
 *   - All consumer services verify with JWT_PUBLIC_KEY (RS256)
 *   - JWT_SECRET is no longer accepted for access-token verification
 *   - HS256 algorithm is rejected — prevents algorithm confusion attacks
 *
 * ENFORCEMENT MODEL:
 * - `algorithms: ['RS256']`  — enforced unconditionally; no HS256/none downgrade
 * - `issuer`                 — passed to jsonwebtoken which rejects tokens with
 *                              missing OR mismatched `iss` claims (not conditional)
 * - `audience`               — same: missing OR mismatched `aud` is rejected
 *
 * BEFORE (HS256 shared secret):
 *   jwtService.verifyAsync(token, { secret: JWT_SECRET, algorithms: ['HS256'] })
 *
 * AFTER (RS256 asymmetric):
 *   jwtService.verifyAsync(token, getJwtVerifyOptions(configService))
 *   // uses publicKey, RS256, issuer, audience — library enforces all claims
 */

/**
 * Type returned by getJwtVerifyOptions — includes `publicKey` so callers don't omit it.
 * SECURITY: `secret` field is intentionally omitted for consumer services.
 * Only auth-service holds the private key for signing.
 */
export type JwtVerifyConfig = JwtVerifyOptions & { publicKey: string };

/** Minimal interface for token type validation — avoids pulling full JwtPayload into backend-common */
interface TokenTypePayload {
  type?: string;
  sub: string;
  jti?: string;
}

/**
 * Enforce strict access token type — SEC-COMPAT SUNSET (2026-04-12).
 *
 * All guards (gateway AuthGuard, farm/hr GqlAuthGuard, subgraph guards)
 * MUST call this after verifyAsync() to prevent refresh or MFA-challenge
 * tokens from being used as access tokens.
 *
 * The SEC-COMPAT backward-compatibility window for pre-hardening tokens
 * (which lacked `type`) has closed. `type === 'access'` is now required.
 *
 * @throws UnauthorizedException if payload.type is absent or not 'access'
 */
export function enforceAccessTokenType(
  payload: TokenTypePayload,
  logger: Logger,
  isProduction: boolean,
): void {
  if (payload.type !== 'access') {
    throw new UnauthorizedException({
      code: 'INVALID_TOKEN_TYPE',
      message: 'Access token required',
    });
  }

  if (!payload.jti) {
    if (isProduction) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN_ID',
        message: 'Token identifier (jti) required',
      });
    }
    logger.warn(`Token without jti for user ${payload.sub} — only permitted outside production.`);
  }
}

export interface TokenRevocationStores {
  readonly tokenBlacklist: {
    isBlacklisted(jti: string): Promise<boolean>;
  };
  readonly userTokenRevocation: {
    isTokenValid(userId: string, issuedAt: Date): Promise<boolean>;
  };
}

interface RevocableAccessTokenPayload {
  readonly sub: string;
  readonly jti?: string;
  readonly iat?: number;
}

/**
 * Canonical post-signature revocation check. Directly reachable auth
 * boundaries must consult both the per-token JTI marker and the user-family
 * invalidation epoch before honoring an otherwise valid access token.
 */
export async function enforceTokenNotRevoked(
  payload: RevocableAccessTokenPayload,
  stores: TokenRevocationStores,
  logger: Logger,
): Promise<void> {
  if (!Number.isSafeInteger(payload.iat) || (payload.iat ?? 0) <= 0) {
    throw new UnauthorizedException({
      code: 'MISSING_ISSUED_AT',
      message: 'Token issued-at claim required',
    });
  }
  const issuedAt = new Date((payload.iat ?? 0) * 1000);
  const tokenRevoked = payload.jti ? await stores.tokenBlacklist.isBlacklisted(payload.jti) : false;
  const userFamilyRevoked = !(await stores.userTokenRevocation.isTokenValid(payload.sub, issuedAt));
  if (!tokenRevoked && !userFamilyRevoked) return;

  logger.warn(`Rejected revoked access token for userId=${payload.sub}`);
  throw new UnauthorizedException({
    code: 'TOKEN_REVOKED',
    message: 'Token has been revoked',
  });
}

/**
 * Load the RSA public key for JWT verification.
 *
 * Supports two modes:
 *   1. JWT_PUBLIC_KEY env var — inline PEM string (base64-encoded or raw)
 *   2. JWT_PUBLIC_KEY_PATH — file path to PEM file
 *
 * @throws Error if neither JWT_PUBLIC_KEY nor JWT_PUBLIC_KEY_PATH is set
 */
/**
 * Resolve the verification public key from config, returning BOTH the raw config
 * inputs (so the memoization cache is keyed by config VALUE, not file bytes) and
 * the materialized PEM. readFileSync runs ONLY here — i.e. only on a cache miss
 * (PERF-MEDIUM-001: previously a per-request synchronous read on ~12 hot-path
 * verify callsites).
 */
function resolvePublicKey(configService: ConfigService): {
  inlinePem?: string;
  keyPath?: string;
  pem: string;
} {
  // SECURITY: Try inline PEM first (Kubernetes secrets, cloud env vars)
  const inlinePem = configService.get<string>('JWT_PUBLIC_KEY');
  if (inlinePem) {
    // Support base64-encoded PEM (common in container orchestrators)
    const pem = inlinePem.includes('-----BEGIN')
      ? inlinePem
      : Buffer.from(inlinePem, 'base64').toString('utf8');
    return { inlinePem, pem };
  }

  // Fall back to file path (docker-compose volume mounts)
  const keyPath = configService.get<string>('JWT_PUBLIC_KEY_PATH');
  if (keyPath) {
    return { keyPath, pem: readFileSync(keyPath, 'utf8') };
  }

  throw new Error(
    'CRITICAL SECURITY ERROR: JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH must be configured. ' +
      'All services require the RSA public key to verify JWT tokens signed by auth-service. ' +
      'Application startup aborted.',
  );
}

/**
 * PERF-MEDIUM-001 memoization cache. Process-local (each service instance caches
 * independently — matches PlatformJwtModule's per-instance useFactory). Keyed on
 * the resolved CONFIG VALUES (inline PEM / key path / issuer / audience), NOT on
 * file contents, so a rotation that points JWT_PUBLIC_KEY_PATH at a new file or
 * swaps the inline PEM misses the cache and re-reads. In-place file replacement
 * at the SAME path must go through the existing config-reload/SIGHUP path (same
 * constraint as HMAC secret rotation).
 */
interface JwtVerifyCache {
  inlinePem?: string;
  keyPath?: string;
  issuer: string;
  audience: string;
  options: Readonly<JwtVerifyConfig>;
}
let jwtVerifyCache: JwtVerifyCache | undefined;

/**
 * Test-only: clear the memoization cache so specs can assert cold-start
 * readFileSync-once behaviour deterministically. Not used in production code.
 */
export function __resetJwtVerifyOptionsCache(): void {
  jwtVerifyCache = undefined;
}

/**
 * Build the standardised JWT verification options using RS256 asymmetric keys.
 *
 * SECURITY: This function enforces RS256-only verification. The platform's
 * auth-service is the sole token issuer (signs with private key). All consumer
 * services verify tokens using the public key loaded by this function.
 *
 * Use with NestJS JwtService:
 * ```typescript
 * const payload = await this.jwtService.verifyAsync<JwtPayload>(
 *   token,
 *   getJwtVerifyOptions(this.configService),
 * );
 * ```
 *
 * @throws Error at startup if JWT_PUBLIC_KEY is not configured.
 */
export function getJwtVerifyOptions(configService: ConfigService): JwtVerifyConfig {
  // PERF-MEDIUM-001: resolve the cheap config scalars first; only re-read the key
  // file + rebuild the (frozen) options object on a cache MISS — i.e. first call
  // and any time a config value actually changes (rotation). Eliminates the
  // per-request readFileSync that ran on every verify across ~12 hot-path
  // callsites. SECURITY semantics are unchanged: RS256-only (algorithm-confusion
  // safe), issuer + audience enforced at the library level (missing/mismatched
  // iss|aud throws). The cache key is the CONFIG VALUE, never file contents, so
  // stale key material cannot be served after a config-driven rotation.
  const inlinePemCfg = configService.get<string>('JWT_PUBLIC_KEY');
  const keyPathCfg = configService.get<string>('JWT_PUBLIC_KEY_PATH');
  const issuer = configService.get<string>('JWT_ISSUER', 'aquaculture-platform');
  const audience = configService.get<string>('JWT_AUDIENCE', 'aquaculture-platform');

  if (
    jwtVerifyCache &&
    jwtVerifyCache.inlinePem === inlinePemCfg &&
    jwtVerifyCache.keyPath === keyPathCfg &&
    jwtVerifyCache.issuer === issuer &&
    jwtVerifyCache.audience === audience
  ) {
    return jwtVerifyCache.options;
  }

  const resolved = resolvePublicKey(configService);
  // Object.freeze<JwtVerifyConfig> so the literal is contextually typed (keeps
  // algorithms as Algorithm[] not string[]) AND the cached options are immutable.
  const options: Readonly<JwtVerifyConfig> = Object.freeze<JwtVerifyConfig>({
    publicKey: resolved.pem,
    algorithms: ['RS256'],
    issuer,
    audience,
  });
  jwtVerifyCache = {
    inlinePem: resolved.inlinePem,
    keyPath: resolved.keyPath,
    issuer,
    audience,
    options,
  };
  return options;
}

/**
 * SSoT for the active signing key id (SEC-HIGH-003).
 *
 * WHY one function: the JWKS endpoint advertises keys keyed by `kid`, but the
 * signer historically omitted the `kid` header — so a verifier in a rotation
 * overlap window could not deterministically select the right public key and
 * had to try-all (weakening the rotation story to best-effort). The token
 * signer and the JWKS controller MUST derive `kid` from this single function
 * so the header on every issued token always matches a published JWKS entry.
 * Drift becomes impossible rather than merely detectable (Tier-1).
 */
export function getActiveSigningKid(configService: ConfigService): string {
  return configService.get<string>('JWT_KEY_ID', 'key-1');
}
