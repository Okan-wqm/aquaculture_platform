/**
 * APA-369 — PlatformAdminGuard accounts failed auth and never hides it at debug.
 *
 * The guard is the FIRST APP_GUARD, so a request with a missing/invalid/expired/
 * forged/revoked Bearer is rejected here BEFORE the shared ThrottlerGuard runs.
 * Failed auth against the platform-admin API was therefore never app-throttled,
 * emitted no security event, and logged only at `logger.debug` (invisible at
 * production log levels). This gate keeps the fix in place:
 *   1. the guard injects the per-IP failed-auth limiter + the security-event
 *      publisher and actually calls them on failure; and
 *   2. the guard never logs at `logger.debug` — auth outcomes on the most
 *      privileged surface must be visible at prod log levels (warn/error).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GUARD = 'apps/admin-api-service/src/guards/platform-admin.guard.ts';

describe('APA-369 — admin failed-auth accounting', () => {
  const src = readFileSync(resolve(REPO_ROOT, GUARD), 'utf-8');

  it('injects the per-IP failed-auth limiter and the security-event publisher', () => {
    expect(src.includes('IpRateLimiterService')).toBe(true);
    expect(src.includes('SecurityEventService')).toBe(true);
  });

  it('accounts each failure against the IP bucket and emits the incident events', () => {
    expect(src.includes('.checkLimit(')).toBe(true);
    expect(src.includes('publishTokenRejected(')).toBe(true);
    expect(src.includes('publishRateLimitExceeded(')).toBe(true);
  });

  it('never logs auth outcomes at debug (must be visible at prod log levels)', () => {
    expect(src.includes('this.logger.debug(')).toBe(false);
  });
});
