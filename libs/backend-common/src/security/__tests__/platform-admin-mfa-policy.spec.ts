import {
  DEFAULT_MFA_FRESHNESS_SECONDS,
  isMfaClaimFresh,
  parsePlatformAdminMfaPolicy,
  readMfaFreshnessSeconds,
  readPlatformAdminMfaPolicy,
} from '../platform-admin-mfa-policy';

const NOW = new Date('2026-09-05T12:00:00Z');

describe('parsePlatformAdminMfaPolicy', () => {
  it('refuses an unset switch in production — an omission is not a decision', () => {
    expect(() => parsePlatformAdminMfaPolicy(undefined, true, NOW)).toThrow(
      /SUPER_ADMIN_MFA_ENFORCED_AT is required in production/,
    );
    expect(() => parsePlatformAdminMfaPolicy('  ', true, NOW)).toThrow(/required in production/);
  });

  it('defaults to detective outside production so local stacks keep working', () => {
    expect(parsePlatformAdminMfaPolicy(undefined, false, NOW)).toEqual({
      mode: 'detective',
      enforcedAt: null,
      enforced: false,
    });
  });

  it("treats 'detective' as the explicit enforcement-off decision", () => {
    expect(parsePlatformAdminMfaPolicy('detective', true, NOW)).toEqual({
      mode: 'detective',
      enforcedAt: null,
      enforced: false,
    });
  });

  it('schedules enforcement for a future date and enforces once the date has passed', () => {
    const scheduled = parsePlatformAdminMfaPolicy('2026-12-01T00:00:00Z', true, NOW);
    expect(scheduled.mode).toBe('scheduled');
    expect(scheduled.enforced).toBe(false);
    expect(scheduled.enforcedAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');

    const enforced = parsePlatformAdminMfaPolicy('2026-09-01T00:00:00Z', true, NOW);
    expect(enforced.mode).toBe('enforced');
    expect(enforced.enforced).toBe(true);
  });

  it('refuses a value that is neither detective nor a date, so a typo cannot disable the control', () => {
    expect(() => parsePlatformAdminMfaPolicy('off', true, NOW)).toThrow(
      /neither 'detective' nor an ISO-8601 date-time/,
    );
    expect(() => parsePlatformAdminMfaPolicy('false', false, NOW)).toThrow(/neither/);
  });

  it('reads the switch and NODE_ENV from an environment', () => {
    expect(
      readPlatformAdminMfaPolicy(
        { NODE_ENV: 'production', SUPER_ADMIN_MFA_ENFORCED_AT: 'detective' },
        NOW,
      ).mode,
    ).toBe('detective');
    expect(() => readPlatformAdminMfaPolicy({ NODE_ENV: 'production' }, NOW)).toThrow(
      /required in production/,
    );
    expect(readPlatformAdminMfaPolicy({ NODE_ENV: 'test' }, NOW).mode).toBe('detective');
  });
});

describe('MFA claim freshness', () => {
  it('defaults the window to fifteen minutes and accepts a positive override', () => {
    expect(readMfaFreshnessSeconds({})).toBe(DEFAULT_MFA_FRESHNESS_SECONDS);
    expect(readMfaFreshnessSeconds({ MFA_FRESHNESS_SECONDS: '300' })).toBe(300);
    expect(() => readMfaFreshnessSeconds({ MFA_FRESHNESS_SECONDS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => readMfaFreshnessSeconds({ MFA_FRESHNESS_SECONDS: 'soon' })).toThrow(
      /positive integer/,
    );
  });

  it('is fresh only for a verified claim minted inside the window', () => {
    const nowSeconds = NOW.getTime() / 1000;
    expect(isMfaClaimFresh(true, nowSeconds - 60, 900, NOW)).toBe(true);
    expect(isMfaClaimFresh(true, nowSeconds - 901, 900, NOW)).toBe(false);
    expect(isMfaClaimFresh(false, nowSeconds, 900, NOW)).toBe(false);
    expect(isMfaClaimFresh(true, undefined, 900, NOW)).toBe(false);
  });
});
