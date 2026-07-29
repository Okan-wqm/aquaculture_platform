/**
 * Integrity contract for the tenant settings vocabulary.
 *
 * The seed migration writes these entries into `config.configurations` verbatim,
 * and the admin panel renders a field per entry, so a malformed entry becomes a
 * malformed row and a broken form at once. This pins the properties both
 * consumers depend on.
 */
import {
  TENANT_SETTINGS,
  TENANT_SETTINGS_SERVICE,
  type TenantSettingSection,
} from '../tenant-settings.vocabulary';

describe('TENANT_SETTINGS vocabulary', () => {
  it('targets its own service namespace', () => {
    // Distinct from `platform`: a tenant's session timeout and the platform's
    // are different rows, and sharing a namespace would make one silently
    // shadow the other through the effective merge.
    expect(TENANT_SETTINGS_SERVICE).toBe('tenant-settings');
    expect(TENANT_SETTINGS_SERVICE).not.toBe('platform');
  });

  it('has unique, namespaced keys', () => {
    const keys = TENANT_SETTINGS.map((setting) => setting.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('names its section in the key prefix of every entry', () => {
    // The prefix is what makes a consumer greppable: `security.mfa_required`
    // says where it belongs without a lookup table.
    const prefixes: Readonly<Record<TenantSettingSection, string>> = {
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
      expect(setting.key.split('.')[0]).toBe(prefixes[setting.section]);
    }
  });

  it('stores every default in a form its declared type parses back', () => {
    for (const setting of TENANT_SETTINGS) {
      if (setting.valueType === 'number') {
        expect(Number.isFinite(Number(setting.defaultValue))).toBe(true);
      }
      if (setting.valueType === 'boolean') {
        expect(['true', 'false']).toContain(setting.defaultValue);
      }
      if (setting.valueType === 'json') {
        const parsed: unknown = JSON.parse(setting.defaultValue);
        // Every `json` entry in this vocabulary is a list of strings; an object
        // default would mean a shape got pushed into a config value.
        expect(Array.isArray(parsed)).toBe(true);
        for (const member of parsed as unknown[]) {
          expect(typeof member).toBe('string');
        }
      }
    }
  });

  it('describes every entry within the column it is stored in', () => {
    for (const setting of TENANT_SETTINGS) {
      expect(setting.description.length).toBeGreaterThan(0);
      // configurations.description is varchar(500).
      expect(setting.description.length).toBeLessThanOrEqual(500);
    }
  });

  it('holds no secret-typed entry', () => {
    // A tenant setting that needed encryption at rest would be a credential,
    // and a credential belongs to the workflow that owns it, not to a settings
    // form that shows every field side by side.
    for (const setting of TENANT_SETTINGS) {
      expect(['string', 'number', 'boolean', 'json']).toContain(setting.valueType);
    }
  });

  it('carries no measurement', () => {
    // `usedStorageGB` sat beside the quota in the retired shape, so a fabricated
    // default was rendered as a tenant's real disk usage. A settings vocabulary
    // holds decisions; measurements come from whatever measures them.
    //
    // `used` / `current` / `actual`, not `count`: `version_retention_count` and
    // `password_history_count` are decisions about how many to keep, which is a
    // setting. The marker of a measurement is that it reports the world.
    const measurementish = TENANT_SETTINGS.filter((setting) =>
      /(^|[._])(used|current|actual|observed)([._]|$)/.test(setting.key),
    );
    expect(measurementish).toEqual([]);
  });
});
