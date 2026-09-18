import 'reflect-metadata';

import {
  RATE_LIMIT_CONFIG_KEY,
  RateLimitRouteConfig,
} from '@aquaculture/backend-common/rate-limit';

import { AuthResolver } from '../resolvers/auth.resolver';
import { MfaResolver } from '../resolvers/mfa.resolver';

/**
 * Rate-limit contract — SEC-CRITICAL-002 regression guard.
 *
 * WHY metadata reflection: the audit found 0-byte rate-limit stubs while
 * comments claimed "rate limited at gateway level" — a control that exists
 * only in prose. These tests pin the @RateLimit windows on every pre-auth
 * mutation so removing or loosening one fails CI loudly (same pattern as the
 * @Roles guard contracts).
 */
describe('Auth pre-auth surface rate-limit contract (SEC-CRITICAL-002)', () => {
  const configOf = (prototype: object, method: string): RateLimitRouteConfig | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (!descriptor?.value) return undefined;
    return Reflect.getMetadata(RATE_LIMIT_CONFIG_KEY, descriptor.value as object) as
      | RateLimitRouteConfig
      | undefined;
  };

  it.each([
    ['login', 5, 15 * 60_000],
    ['refreshToken', 10, 5 * 60_000],
    ['forgotPassword', 3, 60 * 60_000],
    ['resetPassword', 3, 60 * 60_000],
  ])('AuthResolver.%s carries @RateLimit(%i / %ims)', (method, limit, windowMs) => {
    const config = configOf(AuthResolver.prototype, method);
    expect(config).toBeDefined();
    expect(config?.limit).toBe(limit);
    expect(config?.windowMs).toBe(windowMs);
  });

  it('MfaResolver.verifyMfaLogin carries @RateLimit(5 / 15m) keyed by the challenge token', () => {
    const config = configOf(MfaResolver.prototype, 'verifyMfaLogin');
    expect(config).toBeDefined();
    expect(config?.limit).toBe(5);
    expect(config?.windowMs).toBe(15 * 60_000);
    // WHAT the identifier guards: 5 guesses per CHALLENGE, so IP rotation
    // does not refresh the 6-digit TOTP budget.
    expect(config?.identifier?.({ args: { input: { mfaToken: 'challenge-1' } } })).toBe(
      'challenge-1',
    );
  });

  it('login identifier shares one budget per account (case-insensitive email)', () => {
    const config = configOf(AuthResolver.prototype, 'login');
    expect(config?.identifier?.({ args: { input: { email: 'User@X.com' } } })).toBe('user@x.com');
    // No email in args → dimension skipped (falls back to user/tenant/ip).
    expect(config?.identifier?.({ args: {} })).toBeUndefined();
  });
});
