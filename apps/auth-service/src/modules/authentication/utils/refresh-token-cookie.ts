import type { CookieOptions } from 'express';
import { CSRF_SECURITY_POSTURE } from '@aquaculture/shared-contracts';

/**
 * Refresh-token cookie SSoT.
 *
 * WHAT: the single source of truth for the refresh-token cookie's name and
 * options, shared by AuthResolver and MfaResolver (which previously duplicated
 * this logic). The only behavioural variable is `rememberMe`:
 *   - rememberMe true  → PERSISTENT cookie (maxAge present) → survives restarts
 *   - rememberMe false → SESSION cookie (no maxAge/expires) → dropped on close
 * Every other attribute (httpOnly / secure / sameSite=lax / path=/) is identical
 * in both branches, so the security posture never changes — only persistence.
 */
export const REFRESH_TOKEN_COOKIE_NAME = CSRF_SECURITY_POSTURE.refresh.cookieName;

export interface RefreshCookieParams {
  /** secure flag — HTTPS-only cookie in production. */
  isProduction: boolean;
  /** the session's "remember me" choice. */
  rememberMe: boolean;
  /** days the persistent cookie lives when rememberMe is true. */
  rememberMeExpiryDays: number;
}

/**
 * Build the Set-Cookie options for the refresh token. Returns a SESSION cookie
 * (no maxAge) unless rememberMe is true, in which case a maxAge is included.
 */
export function buildRefreshTokenCookieOptions(params: RefreshCookieParams): CookieOptions {
  const base: CookieOptions = {
    httpOnly: CSRF_SECURITY_POSTURE.refresh.httpOnly,
    secure: params.isProduction,
    sameSite: CSRF_SECURITY_POSTURE.refresh.sameSite,
    path: '/',
    // ROOT CAUSE (logout-on-refresh): the refresh-token value is
    // `${userId}:${random}`. Express's default cookie `encode`
    // (encodeURIComponent) turns the ':' into '%3A'; across the
    // browser → nginx → gateway-forward → auth hops that encoding was not
    // decoded symmetrically, so AuthenticationService.refreshTokenWithHash's
    // `indexOf(':')` split saw '%3A' (no colon), derived the wrong tokenPart,
    // and bcrypt.compare never matched a (valid) stored token — every silent
    // refresh failed and logged the user out. ':' is a valid RFC 6265
    // cookie-octet, so encoding it is unnecessary; the identity encoder keeps
    // the SSoT token byte-for-byte stable through every hop.
    encode: (value: string): string => value,
  };

  if (params.rememberMe) {
    return { ...base, maxAge: params.rememberMeExpiryDays * 24 * 60 * 60 * 1000 };
  }
  // Session cookie: deliberately NO maxAge/expires so the browser clears it on close.
  return base;
}

/** Options used to clear the refresh cookie — must match the set attributes. */
export function buildClearRefreshTokenCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: CSRF_SECURITY_POSTURE.refresh.httpOnly,
    secure: isProduction,
    sameSite: CSRF_SECURITY_POSTURE.refresh.sameSite,
    path: '/',
  };
}
