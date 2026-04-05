/**
 * Token Validation Utility
 *
 * Enforces strict access token type checks for all incoming requests.
 *
 * SEC-COMPAT SUNSET (2026-04-12):
 * The backward-compatibility window for pre-hardening legacy tokens
 * (which lacked a `type` field) has closed. JWT_EXPIRES_IN=15m +
 * REFRESH_TOKEN_EXPIRY_DAYS=7 means ALL legacy tokens expired by
 * 2026-04-11 at the latest. The permissive `payload.type &&` guard
 * has been removed — `type === 'access'` is now strictly required.
 *
 * This tightening was recorded in LOW-004 of the 2026-04-04 audit.
 */

import { Logger, UnauthorizedException } from '@nestjs/common';

import { JwtPayload } from '../../types/index';

/**
 * Validate that a JWT payload carries a valid access token type.
 * Rejects any token that is not explicitly typed as 'access'.
 *
 * @param payload - The decoded JWT payload to validate
 * @param logger - Logger instance for jti-less token warnings
 * @param isProduction - Whether the application is running in production mode
 * @throws {UnauthorizedException} If payload.type is absent or not 'access'
 */
export function validateAccessTokenCompat(
  payload: JwtPayload,
  logger: Logger,
  isProduction: boolean,
): void {
  // SEC-COMPAT SUNSET: strict check — type must be explicitly 'access'.
  // Refresh tokens (type='refresh') and MFA challenge tokens (type='mfa_challenge')
  // are rejected. Tokens without a type field are also rejected now that the
  // backward-compatibility window has closed.
  if (payload.type !== 'access') {
    throw new UnauthorizedException({
      code: 'INVALID_TOKEN_TYPE',
      message: 'Access token required',
    });
  }

  // jti is required on all new tokens. A missing jti indicates a very old token
  // that somehow bypassed the expiry window — reject in production.
  if (!payload.jti) {
    if (isProduction) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN_ID',
        message: 'Token identifier (jti) required',
      });
    }
    logger.warn(
      `Token without jti detected for user ${payload.sub} — only permitted outside production.`,
    );
  }
}
