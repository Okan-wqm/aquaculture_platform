/**
 * Round-trip over the tenant settings vocabulary: effective row → typed read →
 * write → the same canonical string the store holds.
 *
 * The defect this guards is specific. The retired page read a shape admin-api
 * synthesized and wrote a shape admin-api rejected, and nothing connected the
 * two — a value could survive a render and die on save. Here the read and the
 * write are the same string, so a field that displays is a field that saves.
 */
import { describe, expect, it } from 'vitest';

import type { EffectiveConfigurationRow } from '../effective-configuration';
import {
  TENANT_SETTINGS,
  TENANT_SETTING_SECTIONS,
  TenantSettingsProjectionError,
  assertTenantSettingWriteReceipt,
  countWrite,
  createTenantSettingsReader,
  draftWrite,
  flagWrite,
  isDraftValid,
  listWrite,
  sectionKeys,
  sectionLabel,
  settingLabel,
  textWrite,
} from '../tenant-configuration';

function row(
  key: string,
  value: unknown,
  source: 'tenant' | 'system' = 'tenant',
): EffectiveConfigurationRow {
  return { key, value, secretMode: 'none', source, version: 1 };
}

function completeRows(
  overrides: readonly EffectiveConfigurationRow[] = [],
): readonly EffectiveConfigurationRow[] {
  const byKey = new Map(overrides.map((override) => [override.key, override]));
  return TENANT_SETTINGS.map(
    (setting) => byKey.get(setting.key) ?? row(setting.key, setting.defaultValue, 'system'),
  );
}

describe('tenant settings reader', () => {
  it('reads a typed row', () => {
    const reader = createTenantSettingsReader(
      completeRows([
        row('limits.max_users', 25),
        row('security.mfa_required', true),
        row('branding.company_name', 'Blue Harvest'),
        row('storage.allowed_file_types', ['pdf', 'csv']),
      ]),
    );

    expect(reader.count('limits.max_users')).toBe(25);
    expect(reader.flag('security.mfa_required')).toBe(true);
    expect(reader.text('branding.company_name')).toBe('Blue Harvest');
    expect(reader.list('storage.allowed_file_types')).toEqual(['pdf', 'csv']);
  });

  it('reads a row that came back as canonical text', () => {
    // A key first written through setConfiguration returns as a string even
    // though its value_type says otherwise. Both forms have to read the same or
    // a field flips type the first time it is saved.
    const reader = createTenantSettingsReader(
      completeRows([
        row('limits.max_users', '25'),
        row('security.mfa_required', 'true'),
        row('storage.allowed_file_types', '["pdf","csv"]'),
      ]),
    );

    expect(reader.count('limits.max_users')).toBe(25);
    expect(reader.flag('security.mfa_required')).toBe(true);
    expect(reader.list('storage.allowed_file_types')).toEqual(['pdf', 'csv']);
  });

  it('rejects an incomplete projection instead of fabricating vocabulary defaults', () => {
    expect(() => createTenantSettingsReader([])).toThrow(TenantSettingsProjectionError);
    expect(() => createTenantSettingsReader([])).toThrow(/missing keys/u);
  });

  it('reports whether a value was decided or defaulted', () => {
    const reader = createTenantSettingsReader(
      completeRows([row('limits.max_users', 25, 'tenant'), row('limits.max_admins', 2, 'system')]),
    );

    expect(reader.isDefault('limits.max_users')).toBe(false);
    expect(reader.isDefault('limits.max_admins')).toBe(true);
    expect(reader.overriddenKeys()).toEqual(['limits.max_users']);
  });

  it('round-trips every value type through canonical()', () => {
    const reader = createTenantSettingsReader(
      completeRows([
        row('limits.max_users', 25),
        row('security.mfa_required', true),
        row('branding.company_name', 'Blue Harvest'),
        row('storage.allowed_file_types', ['pdf', 'csv']),
      ]),
    );

    expect(draftWrite('limits.max_users', reader.canonical('limits.max_users'))).toEqual(
      countWrite('limits.max_users', 25),
    );
    expect(draftWrite('security.mfa_required', reader.canonical('security.mfa_required'))).toEqual(
      flagWrite('security.mfa_required', true),
    );
    expect(draftWrite('branding.company_name', reader.canonical('branding.company_name'))).toEqual(
      textWrite('branding.company_name', 'Blue Harvest'),
    );
    expect(
      draftWrite('storage.allowed_file_types', reader.canonical('storage.allowed_file_types')),
    ).toEqual(listWrite('storage.allowed_file_types', ['pdf', 'csv']));
  });

  it('reads every vocabulary key from the exact seeded store projection', () => {
    const reader = createTenantSettingsReader(completeRows());
    for (const setting of TENANT_SETTINGS) {
      switch (setting.valueType) {
        case 'number':
          expect(Number.isFinite(reader.count(setting.key))).toBe(true);
          break;
        case 'boolean':
          expect(typeof reader.flag(setting.key)).toBe('boolean');
          break;
        case 'json':
          expect(Array.isArray(reader.list(setting.key))).toBe(true);
          break;
        default:
          expect(typeof reader.text(setting.key)).toBe('string');
      }
    }
  });

  it('rejects unknown, duplicate and malformed rows at the projection boundary', () => {
    expect(() =>
      createTenantSettingsReader([...completeRows(), row('unknown.setting', 'value')]),
    ).toThrow(/unknown key/u);
    expect(() =>
      createTenantSettingsReader([...completeRows(), row('limits.max_users', 25)]),
    ).toThrow(/duplicate key/u);
    expect(() =>
      createTenantSettingsReader(completeRows([row('limits.max_users', 'not-a-number')])),
    ).toThrow(/not a finite number/u);
  });

  it('accepts success only from an exact versioned write receipt', () => {
    const write = countWrite('limits.max_users', 25);
    expect(() =>
      assertTenantSettingWriteReceipt(write, {
        key: write.key,
        value: 25,
        version: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertTenantSettingWriteReceipt(write, {
        key: write.key,
        value: 24,
        version: 2,
      }),
    ).toThrow(/receipt value does not match/u);
    expect(() =>
      assertTenantSettingWriteReceipt(write, {
        key: 'security.mfa_required',
        value: 25,
        version: 2,
      }),
    ).toThrow(/receipt key/u);
  });
});

describe('draft validation', () => {
  it('refuses a number cleared to empty', () => {
    // The one case a typed input still lets through. Storing '' under
    // value_type = number puts a row in the store that reads back NaN for every
    // consumer.
    expect(isDraftValid('limits.max_users', '')).toBe(false);
    expect(isDraftValid('limits.max_users', 'abc')).toBe(false);
    expect(isDraftValid('limits.max_users', '25')).toBe(true);
  });

  it('accepts an empty list but refuses malformed list text', () => {
    expect(isDraftValid('storage.allowed_file_types', '[]')).toBe(true);
    expect(isDraftValid('storage.allowed_file_types', '["pdf"]')).toBe(true);
    expect(isDraftValid('storage.allowed_file_types', 'pdf')).toBe(false);
  });

  it('accepts an empty string, which is a real value for a text setting', () => {
    expect(isDraftValid('branding.company_name', '')).toBe(true);
  });
});

describe('sections', () => {
  it('covers every vocabulary key exactly once across the sections', () => {
    // A key in no section would be a setting the page never renders — stored,
    // editable by nothing, exactly the class this replaced.
    const covered = TENANT_SETTING_SECTIONS.flatMap((section) => sectionKeys(section));
    expect([...covered].sort()).toEqual(TENANT_SETTINGS.map((setting) => setting.key).sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('derives labels from the key rather than a second table', () => {
    expect(settingLabel('limits.max_users')).toBe('Max users');
    expect(settingLabel('security.terminate_sessions_on_password_change')).toBe(
      'Terminate sessions on password change',
    );
    expect(sectionLabel('userLimits')).toBe('User limits');
    expect(sectionLabel('retention')).toBe('Retention');
  });
});
