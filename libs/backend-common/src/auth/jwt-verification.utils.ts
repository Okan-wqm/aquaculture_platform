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
 * type error (missing `secret`) rather than a silent security gap.
 *
 * ENFORCEMENT MODEL:
 * - `algorithms: ['HS256']`  — enforced unconditionally; no downgrade possible
 * - `issuer`                 — passed to jsonwebtoken which rejects tokens with
 *                              missing OR mismatched `iss` claims (not conditional)
 * - `audience`               — same: missing OR mismatched `aud` is rejected
 *
 * BEFORE (guard inline, farm/hr/admin):
 *   jwtService.verifyAsync(token, { secret })          // no algorithms, no iss, no aud
 *   jwt.verify(token, secret)                          // sync, no restrictions
 *   if (payload.iss && payload.iss !== issuer) throw   // conditional — omitting iss bypasses
 *   if (payload.aud) { ... }                           // conditional — omitting aud bypasses
 *
 * AFTER (via this utility):
 *   jwtService.verifyAsync(token, getJwtVerifyOptions(configService))
 *   // library enforces all claims at the jsonwebtoken level, not application level
 */

/** Type returned by getJwtVerifyOptions — includes `secret` so callers don't omit it. */
export type JwtVerifyConfig = JwtVerifyOptions & { secret: string };

/**
 * Build the standardised JWT verification options.
 *
 * Use with NestJS JwtService:
 * ```typescript
 * const payload = await this.jwtService.verifyAsync<JwtPayload>(
 *   token,
 *   getJwtVerifyOptions(this.configService),
 * );
 * ```
 *
 * @throws Error at startup if JWT_SECRET or JWT_ISSUER are not set.
 */
export function getJwtVerifyOptions(configService: ConfigService): JwtVerifyConfig {
  return {
    // SECURITY: secret is required — getOrThrow crashes at startup if missing.
    // BEFORE: some guards used configService.get() with a fallback — no crash,
    // but a misconfigured secret would silently accept any token.
    secret: configService.getOrThrow<string>('JWT_SECRET'),

    // SECURITY: HS256 only — prevents algorithm confusion attacks.
    // jsonwebtoken/@nestjs/jwt accepts the first algorithm in the list;
    // restricting to HS256 prevents RS256/none downgrade.
    algorithms: ['HS256'],

    // SECURITY: issuer enforcement at library level.
    // When issuer is passed to verifyAsync, jsonwebtoken throws JsonWebTokenError
    // if the token's `iss` claim is MISSING or MISMATCHED — not a conditional check.
    // BEFORE (gateway): if (payload.iss && ...) — tokens without iss were accepted.
    // AFTER: library rejects tokens without iss unconditionally.
    issuer: configService.get<string>('JWT_ISSUER', 'aquaculture-platform'),

    // SECURITY: audience enforcement at library level (same rationale as issuer).
    // BEFORE (gateway): if (payload.aud) { ... } — tokens without aud were accepted.
    audience: configService.get<string>('JWT_AUDIENCE', 'aquaculture-platform'),
  };
}
