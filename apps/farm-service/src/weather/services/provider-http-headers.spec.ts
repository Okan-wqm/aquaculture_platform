import { parseProviderRetryAfterMs } from './provider-http-headers';

describe('provider HTTP header parsing', () => {
  const now = new Date('2026-07-31T04:30:00.000Z');

  it('accepts only decimal delta-seconds for the numeric Retry-After form', () => {
    expect(parseProviderRetryAfterMs('37', now, 60_000)).toBe(37_000);
    expect(parseProviderRetryAfterMs('1e3', now, 60_000)).toBeUndefined();
    expect(parseProviderRetryAfterMs('+1', now, 60_000)).toBeUndefined();
    expect(parseProviderRetryAfterMs('1.5', now, 60_000)).toBeUndefined();
  });

  it('accepts IMF-fixdate, clamps past dates to zero, and caps untrusted delays', () => {
    expect(parseProviderRetryAfterMs('Fri, 31 Jul 2026 04:30:20 GMT', now, 60_000)).toBe(20_000);
    expect(parseProviderRetryAfterMs('Fri, 31 Jul 2026 04:29:00 GMT', now, 60_000)).toBe(0);
    expect(parseProviderRetryAfterMs('999999999999999999999', now, 60_000)).toBe(60_000);
  });
});
