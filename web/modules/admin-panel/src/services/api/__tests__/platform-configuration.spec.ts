/**
 * Platform Configuration data layer tests (ORPHAN-HIGH-373)
 *
 * The pure mapping between config-service effective-configuration rows and the
 * System Settings tab models, plus the per-tab write builders. Rows arrive as
 * GraphQLJSON — typed for seeded rows, plain strings for keys created through
 * setConfiguration — so both encodings are covered.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_CONFIGURATION_SERVICE,
  buildBillingWrites,
  buildEmailWrites,
  buildGeneralWrites,
  buildRateLimitWrites,
  buildSecurityWrites,
  coerceBoolean,
  coerceNumber,
  mapPlatformSettings,
} from '../platform-configuration';
import type { EffectiveConfigurationRow } from '../platform-configuration';

function row(
  key: string,
  value: unknown,
  secretMode: 'none' | 'redacted' = 'none',
): EffectiveConfigurationRow {
  return { key, value, secretMode, source: 'system', version: 1 };
}

describe('platform-configuration service namespace', () => {
  it('targets the seeded platform namespace', () => {
    expect(PLATFORM_CONFIGURATION_SERVICE).toBe('platform');
  });
});

describe('coercion', () => {
  it('accepts typed and canonical-string encodings', () => {
    expect(coerceNumber(480, 0)).toBe(480);
    expect(coerceNumber('480', 0)).toBe(480);
    expect(coerceNumber('abc', 7)).toBe(7);
    expect(coerceNumber('', 7)).toBe(7);
    expect(coerceBoolean(true, false)).toBe(true);
    expect(coerceBoolean('true', false)).toBe(true);
    expect(coerceBoolean('false', true)).toBe(false);
    expect(coerceBoolean('nope', true)).toBe(true);
  });
});

describe('mapPlatformSettings', () => {
  it('maps typed seeded rows into the tab models', () => {
    const settings = mapPlatformSettings([
      row('platform.name', 'Aquaculture Platform'),
      row('platform.version', '1.0.0'),
      row('maintenance.mode_enabled', true),
      row('email.smtp_host', 'smtp.example.com'),
      row('email.smtp_port', 465),
      row('email.smtp_secure', true),
      row('email.smtp_username', 'mailer'),
      row('email.smtp_password', '[ENCRYPTED]', 'redacted'),
      row('email.from_address', 'noreply@example.com'),
      row('email.from_name', 'Example'),
      row('security.session_timeout_minutes', 120),
      row('security.mfa_enabled', false),
      row('billing.stripe_enabled', true),
      row('billing.tax_rate', 18),
      row('rate_limit.global_rpm', 2000),
    ]);

    expect(settings.general).toEqual({
      platformName: 'Aquaculture Platform',
      platformVersion: '1.0.0',
      maintenanceMode: true,
    });
    expect(settings.email.smtpHost).toBe('smtp.example.com');
    expect(settings.email.smtpPort).toBe(465);
    expect(settings.email.smtpSecure).toBe(true);
    // Secrets are never surfaced into the editable input...
    expect(settings.email.smtpPassword).toBe('');
    // ...but a stored (redacted, non-null) secret is signalled.
    expect(settings.email.hasSmtpPassword).toBe(true);
    expect(settings.security.sessionTimeoutMinutes).toBe(120);
    expect(settings.security.mfaEnabled).toBe(false);
    expect(settings.billing.stripeEnabled).toBe(true);
    expect(settings.billing.taxRate).toBe(18);
    expect(settings.billing.stripeSecretKey).toBe('');
    expect(settings.rateLimits.globalRpm).toBe(2000);
  });

  it('maps canonical-string rows (post-setConfiguration inserts) identically', () => {
    const settings = mapPlatformSettings([
      row('security.password_require_symbols', 'true'),
      row('rate_limit.per_user_rpm', '250'),
      row('maintenance.mode_enabled', 'false'),
    ]);

    expect(settings.security.passwordRequireSymbols).toBe(true);
    expect(settings.rateLimits.perUserRpm).toBe(250);
    expect(settings.general.maintenanceMode).toBe(false);
  });

  it('treats a null-valued secret row as "no secret stored"', () => {
    // config-service returns value: null for the seeded empty smtp password.
    const settings = mapPlatformSettings([row('email.smtp_password', null, 'redacted')]);
    expect(settings.email.hasSmtpPassword).toBe(false);
  });

  it('falls back to the seeded defaults for missing rows', () => {
    const settings = mapPlatformSettings([]);
    expect(settings).toEqual(DEFAULT_PLATFORM_SETTINGS);
  });
});

describe('write builders', () => {
  it('serializes general and rate-limit writes to canonical strings', () => {
    expect(buildGeneralWrites(true)).toEqual([{ key: 'maintenance.mode_enabled', value: 'true' }]);

    const rateWrites = buildRateLimitWrites({
      globalRpm: 1500,
      perUserRpm: 100,
      perTenantRpm: 500,
      apiKeyRpm: 60,
    });
    expect(rateWrites).toContainEqual({ key: 'rate_limit.global_rpm', value: '1500' });
    expect(rateWrites).toHaveLength(4);
  });

  it('covers every security field with a namespaced key', () => {
    const writes = buildSecurityWrites(DEFAULT_PLATFORM_SETTINGS.security);
    expect(writes).toHaveLength(9);
    expect(writes.map((write) => write.key)).toEqual([
      'security.session_timeout_minutes',
      'security.max_login_attempts',
      'security.lockout_duration_minutes',
      'security.password_min_length',
      'security.password_require_uppercase',
      'security.password_require_numbers',
      'security.password_require_symbols',
      'security.mfa_enabled',
      'security.enforce_https',
    ]);
  });

  it('sends the smtp password only when the operator typed one, flagged secret', () => {
    const untouched = buildEmailWrites({
      ...DEFAULT_PLATFORM_SETTINGS.email,
      smtpPassword: '',
    });
    expect(untouched.some((write) => write.key === 'email.smtp_password')).toBe(false);

    const updated = buildEmailWrites({
      ...DEFAULT_PLATFORM_SETTINGS.email,
      smtpPassword: 's3cret',
    });
    expect(updated).toContainEqual({
      key: 'email.smtp_password',
      value: 's3cret',
      isSecret: true,
    });
  });

  it('sends the stripe secret key only when typed, flagged secret', () => {
    const untouched = buildBillingWrites(DEFAULT_PLATFORM_SETTINGS.billing);
    expect(untouched.some((write) => write.key === 'billing.stripe_secret_key')).toBe(false);
    expect(untouched).toContainEqual({ key: 'billing.stripe_enabled', value: 'false' });

    const updated = buildBillingWrites({
      ...DEFAULT_PLATFORM_SETTINGS.billing,
      stripeSecretKey: 'sk_test_123',
    });
    expect(updated).toContainEqual({
      key: 'billing.stripe_secret_key',
      value: 'sk_test_123',
      isSecret: true,
    });
  });
});
