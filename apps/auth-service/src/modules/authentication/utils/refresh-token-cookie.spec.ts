import {
  REFRESH_TOKEN_COOKIE_NAME,
  buildRefreshTokenCookieOptions,
  buildClearRefreshTokenCookieOptions,
} from './refresh-token-cookie';

/**
 * Refresh-token cookie SSoT — the core "remember me" contract (ORPHAN-LOW-135):
 * remembered → persistent cookie (maxAge present); not remembered → SESSION
 * cookie (no maxAge). Security attributes are identical in both branches.
 */
describe('buildRefreshTokenCookieOptions', () => {
  it('rememberMe=true → persistent cookie with maxAge = expiry days', () => {
    const opts = buildRefreshTokenCookieOptions({
      isProduction: true,
      rememberMe: true,
      rememberMeExpiryDays: 30,
    });
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
  });

  it('rememberMe=false → SESSION cookie with NO maxAge/expires', () => {
    const opts = buildRefreshTokenCookieOptions({
      isProduction: true,
      rememberMe: false,
      rememberMeExpiryDays: 30,
    });
    expect('maxAge' in opts).toBe(false);
    expect('expires' in opts).toBe(false);
    // security attributes unchanged vs the persistent branch
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
  });

  it('secure flag follows isProduction', () => {
    expect(
      buildRefreshTokenCookieOptions({ isProduction: false, rememberMe: true, rememberMeExpiryDays: 30 })
        .secure,
    ).toBe(false);
  });

  // ROOT CAUSE (logout-on-refresh): the refresh token is `${userId}:${random}`.
  // The default cookie encoder turns ':' into '%3A', which broke the
  // server-side `indexOf(':')` split. The identity encoder keeps the value
  // byte-for-byte stable across every transport hop.
  it('uses an identity encoder so the token value is NOT URL-encoded (":" stays ":")', () => {
    for (const rememberMe of [true, false]) {
      const opts = buildRefreshTokenCookieOptions({ isProduction: true, rememberMe, rememberMeExpiryDays: 30 });
      expect(typeof opts.encode).toBe('function');
      const sample = '8025339a-e6c7-46df-b65a-dcf4f010b861:7acbcb0bf6efac13';
      expect(opts.encode!(sample)).toBe(sample); // no '%3A', no mutation
    }
  });
});

describe('buildClearRefreshTokenCookieOptions', () => {
  it('matches the set attributes and carries no maxAge', () => {
    const opts = buildClearRefreshTokenCookieOptions(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect('maxAge' in opts).toBe(false);
  });
});

describe('REFRESH_TOKEN_COOKIE_NAME', () => {
  it('is the canonical cookie name', () => {
    expect(REFRESH_TOKEN_COOKIE_NAME).toBe('refresh_token');
  });
});
