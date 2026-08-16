import {
  TENANT_HASH_PEPPER_ENV,
  assertTenantHashPepperSet,
  hmacTenantHash,
  tenantHashesEqual,
} from '../hmac-tenant-hash.util';

describe('hmac-tenant-hash', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('hmacTenantHash', () => {
    it('produces a 64-char hex string (SHA-256 output)', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const hash = hmacTenantHash('tenant_abc123def456789a');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for a given pepper + input', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const h1 = hmacTenantHash('tenant_abc123def456789a');
      const h2 = hmacTenantHash('tenant_abc123def456789a');
      expect(h1).toBe(h2);
    });

    it('produces different output for different pepper values', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const h1 = hmacTenantHash('tenant_abc123def456789a');
      process.env[TENANT_HASH_PEPPER_ENV] = 'b'.repeat(64);
      const h2 = hmacTenantHash('tenant_abc123def456789a');
      expect(h1).not.toBe(h2);
    });

    it('produces different output for different tenant schemas', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const h1 = hmacTenantHash('tenant_abc123def456789a');
      const h2 = hmacTenantHash('tenant_bbc123def456789a');
      expect(h1).not.toBe(h2);
    });

    it('throws on empty or non-string input (defense at trust boundary)', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      expect(() => hmacTenantHash('')).toThrow(/non-empty string/);
      expect(() => hmacTenantHash(undefined as unknown as string)).toThrow();
      expect(() => hmacTenantHash(null as unknown as string)).toThrow();
    });

    it('uses dev-only default when NODE_ENV !== production and env unset', () => {
      Reflect.deleteProperty(process.env, TENANT_HASH_PEPPER_ENV);
      process.env['NODE_ENV'] = 'development';
      expect(() => hmacTenantHash('tenant_abc123def456789a')).not.toThrow();
    });

    it('throws when NODE_ENV=production and env unset (fail-closed)', () => {
      Reflect.deleteProperty(process.env, TENANT_HASH_PEPPER_ENV);
      process.env['NODE_ENV'] = 'production';
      expect(() => hmacTenantHash('tenant_abc123def456789a')).toThrow(/REQUIRED in production/);
    });

    it('matches known RFC-4231-style test vector for HMAC-SHA256', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'key'.padEnd(32, 'k');
      const out = hmacTenantHash('The quick brown fox jumps over the lazy dog');
      expect(out).toMatch(/^[0-9a-f]{64}$/);
      expect(out.length).toBe(64);
    });
  });

  describe('assertTenantHashPepperSet', () => {
    it('passes silently when env var is set to a valid-length value', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const warn = jest.fn();
      assertTenantHashPepperSet({ warn });
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs warn in non-prod when env var is unset', () => {
      Reflect.deleteProperty(process.env, TENANT_HASH_PEPPER_ENV);
      process.env['NODE_ENV'] = 'development';
      const warn = jest.fn();
      assertTenantHashPepperSet({ warn });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev-only default'));
    });

    it('throws in production when env var is unset', () => {
      Reflect.deleteProperty(process.env, TENANT_HASH_PEPPER_ENV);
      process.env['NODE_ENV'] = 'production';
      expect(() => assertTenantHashPepperSet()).toThrow(/REQUIRED in production/);
    });

    it('throws when env var is too short (weak entropy)', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'short';
      expect(() => assertTenantHashPepperSet()).toThrow(/too short/);
    });
  });

  describe('tenantHashesEqual', () => {
    it('returns true for identical hashes', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const h = hmacTenantHash('tenant_abc123def456789a');
      expect(tenantHashesEqual(h, h)).toBe(true);
    });

    it('returns false for different hashes', () => {
      process.env[TENANT_HASH_PEPPER_ENV] = 'a'.repeat(64);
      const h1 = hmacTenantHash('tenant_abc123def456789a');
      const h2 = hmacTenantHash('tenant_bbc123def456789a');
      expect(tenantHashesEqual(h1, h2)).toBe(false);
    });

    it('returns false for length-mismatched inputs (no throw)', () => {
      expect(tenantHashesEqual('short', 'a'.repeat(64))).toBe(false);
    });

    it('returns false for invalid hex (no throw)', () => {
      const h = 'a'.repeat(64);
      expect(tenantHashesEqual(h, 'z'.repeat(64))).toBe(false);
    });
  });
});
