import {
  TENANT_SETTINGS,
  TENANT_SETTINGS_SERVICE,
  type TenantSettingSection,
} from '../tenant-settings';

describe('tenant settings vocabulary authority', () => {
  it('owns one non-trivial, unique and parseable key set', () => {
    const keys = TENANT_SETTINGS.map((setting) => setting.key);
    expect(TENANT_SETTINGS_SERVICE).toBe('tenant-settings');
    expect(keys.length).toBe(90);
    expect(new Set(keys).size).toBe(keys.length);
    for (const setting of TENANT_SETTINGS) {
      expect(setting.key).toMatch(/^[a-z_]+(?:\.[a-z0-9_]+)+$/u);
      expect(setting.description.length).toBeGreaterThan(0);
      if (setting.valueType === 'number') {
        expect(Number.isFinite(Number(setting.defaultValue))).toBe(true);
      } else if (setting.valueType === 'boolean') {
        expect(['true', 'false']).toContain(setting.defaultValue);
      } else if (setting.valueType === 'json') {
        const parsed: unknown = JSON.parse(setting.defaultValue);
        expect(Array.isArray(parsed)).toBe(true);
        expect((parsed as unknown[]).every((member) => typeof member === 'string')).toBe(true);
      }
    }
  });

  it('binds each section to one stable key namespace', () => {
    const prefix: Readonly<Record<TenantSettingSection, string>> = {
      userLimits: 'limits',
      storage: 'storage',
      api: 'api',
      branding: 'branding',
      security: 'security',
      notifications: 'notifications',
      features: 'features',
      retention: 'retention',
    };
    for (const setting of TENANT_SETTINGS) {
      expect(setting.key.split('.')[0]).toBe(prefix[setting.section]);
    }
  });

  it('contains decisions only, never secrets or measured state', () => {
    expect(
      TENANT_SETTINGS.filter((setting) =>
        /(^|[._])(used|current|actual|observed)([._]|$)/u.test(setting.key),
      ),
    ).toEqual([]);
    expect(TENANT_SETTINGS.every((setting) => setting.valueType !== ('secret' as string))).toBe(
      true,
    );
  });
});
