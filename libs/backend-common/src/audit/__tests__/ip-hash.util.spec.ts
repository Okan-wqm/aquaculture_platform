import {
  hashIpForGdpr,
  isForceHashAllIpsEnabled,
  readIpHashingPolicyFromEnv,
  shouldHashIp,
} from '../ip-hash.util';

/**
 * ip-hash.util — pin every audit-IP-hashing rule (AUDITTRAIL-LOW-002)
 * ============================================================================
 *
 * # Why this spec exists
 *
 * `hashIpForGdpr` and `shouldHashIp` are the canonical platform-wide
 * helpers for region-gated audit-IP hashing. Both audit interceptors
 * consume them directly. A regex regression in the salt path or a
 * mis-matched region predicate would silently let plaintext IPs land
 * on EU-subject audit rows — a GDPR Art 6 / Art 32 violation.
 *
 * Specs below pin:
 *
 *   - hashIpForGdpr is salted SHA-256 (deterministic, not reversible
 *     without the salt, hex output 64 chars).
 *   - hashIpForGdpr returns null on null/empty inputs (caller
 *     convention).
 *   - The closed EU_REGIONS set is exhaustive and case-insensitive.
 *   - The shouldHashIp policy matrix matches the docstring's truth
 *     table exactly: forceHash, EU member, non-EU member, unknown
 *     with/without conservative-default opt-in.
 *   - readIpHashingPolicyFromEnv parses both 'true' and '1' and
 *     ignores other strings.
 */
describe('ip-hash.util — audit-IP region-gated hashing (AUDITTRAIL-LOW-002)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('hashIpForGdpr', () => {
    it('returns hex SHA-256 (64 chars) for a non-empty IP', () => {
      const out = hashIpForGdpr('203.0.113.1');
      expect(out).not.toBeNull();
      expect(out).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic across calls with the same salt', () => {
      process.env['AUDIT_IP_HASH_SALT'] = 'fixed-salt';
      const a = hashIpForGdpr('203.0.113.1');
      const b = hashIpForGdpr('203.0.113.1');
      expect(a).toBe(b);
    });

    it('produces different hashes for different IPs (no collision under same salt)', () => {
      process.env['AUDIT_IP_HASH_SALT'] = 'fixed-salt';
      const a = hashIpForGdpr('203.0.113.1');
      const b = hashIpForGdpr('203.0.113.2');
      expect(a).not.toBe(b);
    });

    it('produces different hashes for the same IP under different salts (no rainbow-table fragility)', () => {
      process.env['AUDIT_IP_HASH_SALT'] = 'salt-A';
      const a = hashIpForGdpr('203.0.113.1');
      process.env['AUDIT_IP_HASH_SALT'] = 'salt-B';
      const b = hashIpForGdpr('203.0.113.1');
      expect(a).not.toBe(b);
    });

    it('returns null for null input', () => {
      expect(hashIpForGdpr(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(hashIpForGdpr(undefined)).toBeNull();
    });

    it('returns null for empty-string input', () => {
      expect(hashIpForGdpr('')).toBeNull();
    });

    it('handles IPv6 strings without crashing', () => {
      const out = hashIpForGdpr('2001:db8::1');
      expect(out).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('shouldHashIp policy matrix', () => {
    it('forceHashAllIps=true overrides everything (returns true even for explicit non-EU)', () => {
      expect(
        shouldHashIp('us', { forceHashAllIps: true, hashUnknownRegions: false }),
      ).toBe(true);
    });

    it('returns true for EU-aggregate marker "eu"', () => {
      expect(shouldHashIp('eu', {})).toBe(true);
    });

    it('returns true for EEA marker', () => {
      expect(shouldHashIp('eea', {})).toBe(true);
    });

    it('returns true for an EU-27 country code', () => {
      expect(shouldHashIp('de', {})).toBe(true);
      expect(shouldHashIp('fr', {})).toBe(true);
      expect(shouldHashIp('it', {})).toBe(true);
    });

    it('is case-insensitive on country codes', () => {
      expect(shouldHashIp('DE', {})).toBe(true);
      expect(shouldHashIp('Fr', {})).toBe(true);
    });

    it('returns false for non-EU country code', () => {
      expect(shouldHashIp('us', {})).toBe(false);
      expect(shouldHashIp('tr', {})).toBe(false);
      expect(shouldHashIp('br', {})).toBe(false);
    });

    it('returns false on null region when hashUnknownRegions is off (legacy default)', () => {
      expect(shouldHashIp(null, { hashUnknownRegions: false })).toBe(false);
      expect(shouldHashIp(undefined, {})).toBe(false);
    });

    it('returns true on null region when hashUnknownRegions is on (conservative opt-in)', () => {
      expect(shouldHashIp(null, { hashUnknownRegions: true })).toBe(true);
      expect(shouldHashIp(undefined, { hashUnknownRegions: true })).toBe(true);
    });

    it('UK is NOT in the EU set (post-Brexit) until an explicit ADR adds it', () => {
      expect(shouldHashIp('gb', {})).toBe(false);
      expect(shouldHashIp('uk', {})).toBe(false);
    });
  });

  describe('readIpHashingPolicyFromEnv', () => {
    it('parses "true" as true', () => {
      process.env['AUDIT_FORCE_IP_HASH'] = 'true';
      process.env['AUDIT_HASH_UNKNOWN_REGIONS'] = 'true';
      const p = readIpHashingPolicyFromEnv();
      expect(p.forceHashAllIps).toBe(true);
      expect(p.hashUnknownRegions).toBe(true);
    });

    it('parses "1" as true', () => {
      process.env['AUDIT_FORCE_IP_HASH'] = '1';
      process.env['AUDIT_HASH_UNKNOWN_REGIONS'] = '1';
      const p = readIpHashingPolicyFromEnv();
      expect(p.forceHashAllIps).toBe(true);
      expect(p.hashUnknownRegions).toBe(true);
    });

    it('returns false for unset env vars', () => {
      delete process.env['AUDIT_FORCE_IP_HASH'];
      delete process.env['AUDIT_HASH_UNKNOWN_REGIONS'];
      const p = readIpHashingPolicyFromEnv();
      expect(p.forceHashAllIps).toBe(false);
      expect(p.hashUnknownRegions).toBe(false);
    });

    it('returns false for "false" / arbitrary strings (only "true" and "1" enable)', () => {
      process.env['AUDIT_FORCE_IP_HASH'] = 'false';
      process.env['AUDIT_HASH_UNKNOWN_REGIONS'] = 'TRUE';
      const p = readIpHashingPolicyFromEnv();
      expect(p.forceHashAllIps).toBe(false);
      expect(p.hashUnknownRegions).toBe(false);
    });
  });

  describe('isForceHashAllIpsEnabled (deprecated single-flag accessor)', () => {
    it('still works on the same env var as a back-compat shim', () => {
      process.env['AUDIT_FORCE_IP_HASH'] = 'true';
      expect(isForceHashAllIpsEnabled()).toBe(true);
      process.env['AUDIT_FORCE_IP_HASH'] = '1';
      expect(isForceHashAllIpsEnabled()).toBe(true);
      delete process.env['AUDIT_FORCE_IP_HASH'];
      expect(isForceHashAllIpsEnabled()).toBe(false);
    });
  });
});
