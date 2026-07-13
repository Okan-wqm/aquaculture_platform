import {
  PLATFORM_CONFIGURATION_SEED,
  PLATFORM_CONFIGURATION_SERVICE,
} from '../migrations/1805400000000-SeedPlatformConfigurations';

/**
 * Integrity contract for the platform-scope configuration seed
 * (ORPHAN-HIGH-373). The rows are a faithful derivation of admin-api's
 * DEFAULT_SYSTEM_SETTINGS vocabulary (35 entries) mapped onto the
 * config.configurations column semantics — this spec pins the mapping
 * invariants so a future edit cannot silently corrupt the seed.
 */
describe('PLATFORM_CONFIGURATION_SEED', () => {
  it('targets the platform service namespace', () => {
    expect(PLATFORM_CONFIGURATION_SERVICE).toBe('platform');
  });

  it('carries the full 35-entry vocabulary with unique namespaced keys', () => {
    expect(PLATFORM_CONFIGURATION_SEED).toHaveLength(35);

    const keys = PLATFORM_CONFIGURATION_SEED.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      // Namespaced dotted keys, e.g. `platform.name`, `rate_limit.global_rpm`.
      expect(key).toMatch(/^[a-z_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('stays inside the configurations enum + category domains', () => {
    const valueTypes = new Set(['string', 'number', 'boolean', 'json', 'secret']);
    const categories = new Set([
      'general',
      'security',
      'email',
      'rate_limit',
      'storage',
      'maintenance',
      'billing',
      'feature_flag',
    ]);

    for (const row of PLATFORM_CONFIGURATION_SEED) {
      expect(valueTypes.has(row.valueType)).toBe(true);
      expect(categories.has(row.category)).toBe(true);
      expect(row.description.length).toBeGreaterThan(0);
      expect(row.description.length).toBeLessThanOrEqual(500);
    }
  });

  it('stores every value in a form its declared type can parse back', () => {
    for (const row of PLATFORM_CONFIGURATION_SEED) {
      if (row.valueType === 'number') {
        expect(Number.isFinite(Number(row.value))).toBe(true);
      }
      if (row.valueType === 'boolean') {
        expect(['true', 'false']).toContain(row.value);
      }
      if (row.valueType === 'json') {
        expect(() => JSON.parse(row.value)).not.toThrow();
      }
    }
  });

  it('marks exactly the smtp password as the secret entry, with no plaintext payload', () => {
    const secrets = PLATFORM_CONFIGURATION_SEED.filter((row) => row.valueType === 'secret');
    expect(secrets.map((row) => row.key)).toEqual(['email.smtp_password']);
    // A seed migration must never ship a plaintext secret value.
    expect(secrets[0]?.value).toBe('');
  });

  it('uses only the sanctioned classification tags', () => {
    const allowed = new Set(['public', 'read-only', 'requires-restart']);
    for (const row of PLATFORM_CONFIGURATION_SEED) {
      for (const tag of row.tags ?? []) {
        expect(allowed.has(tag)).toBe(true);
      }
    }
  });

  it('preserves the vocabulary values verbatim (spot checks)', () => {
    const byKey = new Map(PLATFORM_CONFIGURATION_SEED.map((row) => [row.key, row]));

    expect(byKey.get('platform.name')?.value).toBe('Aquaculture Platform');
    expect(byKey.get('platform.version')?.tags).toEqual(['public', 'read-only']);
    expect(byKey.get('security.session_timeout_minutes')?.value).toBe('480');
    expect(byKey.get('rate_limit.global_rpm')?.value).toBe('1000');
    expect(byKey.get('email.from_address')?.value).toBe('noreply@aquaculture.io');
    expect(JSON.parse(byKey.get('storage.allowed_extensions')?.value ?? '[]')).toEqual([
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'csv',
      'jpg',
      'jpeg',
      'png',
      'gif',
      'mp4',
    ]);
    expect(byKey.get('maintenance.mode_enabled')?.value).toBe('false');
    expect(byKey.get('feature.graphql_playground')?.value).toBe('false');
  });
});
