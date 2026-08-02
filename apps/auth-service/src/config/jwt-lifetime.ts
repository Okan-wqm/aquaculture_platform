import { MAX_USER_TOKEN_LIFETIME_SECONDS } from '@aquaculture/backend-common/security';

import { SECURITY_CONSTANTS } from '../constants/auth.constants';

const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
} as const;

/**
 * Parse and validate the access-token lifetime shared by JWT signing, cookies,
 * and the user-revocation marker. Invalid/zero/overlong values fail startup or
 * token mint rather than silently falling back to a different lifetime.
 */
export function parseAccessTokenLifetimeSeconds(expiresIn: string): number {
  const match = /^(\d+)([smhdw])$/.exec(expiresIn);
  if (!match?.[1] || !match[2]) {
    throw new RangeError('JWT_EXPIRES_IN must be a positive duration such as 15m or 1h');
  }

  const value = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_SECONDS;
  const seconds = value * UNIT_SECONDS[unit];
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError('JWT_EXPIRES_IN must resolve to positive safe-integer seconds');
  }
  if (seconds > MAX_USER_TOKEN_LIFETIME_SECONDS) {
    throw new RangeError(
      `JWT_EXPIRES_IN must not exceed ${MAX_USER_TOKEN_LIFETIME_SECONDS} seconds`,
    );
  }
  return seconds;
}

/** Validated default exported for startup/config invariants. */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = parseAccessTokenLifetimeSeconds(
  SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_IN,
);
