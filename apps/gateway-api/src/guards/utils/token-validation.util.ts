/**
 * Token Validation Utility
 *
 * Centralizes SEC-COMPAT backward-compatibility checks for pre-hardening tokens.
 * Used by both AuthGuard and JwtMiddleware to avoid duplicating validation logic.
 *
 * SEC-COMPAT: The `type` field is optional for backward compatibility with
 * tokens issued before the security hardening (pre-2026-04). Legacy tokens
 * do not carry `type` or `jti`. During the transition period, tokens without
 * `type` are treated as access tokens. Once all legacy tokens have expired
 * (max JWT lifetime), `type` should be changed back to required and the
 * backward-compat guards removed.
 */

import { Logger, UnauthorizedException } from '@nestjs/common';

import { JwtPayload } from '../../types/index';

/**
 * SEC-COMPAT: Validate access token type and log legacy token warnings.
 * Centralizes backward-compatibility checks for pre-hardening tokens.
 *
 * @param payload - The decoded JWT payload to validate
 * @param logger - Logger instance for warning output
 * @param isProduction - Whether the application is running in production mode
 * @throws {UnauthorizedException} If payload type is explicitly non-access
 */
export function validateAccessTokenCompat(
  payload: JwtPayload,
  logger: Logger,
  isProduction: boolean,
): void {
  /**
   * Token type check with backward compatibility.
   * Legacy tokens (pre-hardening) do not carry a `type` field. Tokens
   * without `type` are treated as access tokens during the transition
   * period. Only explicitly non-access types (e.g. 'refresh') are
   * rejected. Once all legacy tokens have expired, tighten this to
   * require `payload.type === 'access'`.
   */
  if (payload.type && payload.type !== 'access') {
    throw new UnauthorizedException({
      code: 'INVALID_TOKEN_TYPE',
      message: 'Access token required',
    });
  }

  /**
   * Legacy tokens without jti cannot be individually revoked
   * but are still cryptographically valid. Log for monitoring and allow
   * during transition period. New tokens always include jti.
   */
  if (isProduction && !payload.jti) {
    logger.warn(
      `Legacy token without jti detected for user ${payload.sub} — token cannot be individually revoked. Will be replaced on next login.`,
    );
  }
}
