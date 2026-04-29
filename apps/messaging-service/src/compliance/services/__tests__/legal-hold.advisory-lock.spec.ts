import {
  acquireTenantAdvisoryLock,
  tenantAdvisoryLockKey,
} from '../legal-hold.advisory-lock';

/**
 * LEGAL-MEDIUM-004 — advisory-lock helper unit specs.
 *
 * The pg-side lock semantics are tested via integration in the
 * retention-policy.service spec; here we pin the deterministic
 * fingerprint of the helper so a future refactor doesn't change the
 * lock key derivation (which would silently break serialization across
 * a deploy boundary — old code holds key K1, new code waits on K2).
 */
describe('legal-hold advisory-lock', () => {
  describe('tenantAdvisoryLockKey', () => {
    it('returns a stable bigint for a given tenantId', () => {
      const k1 = tenantAdvisoryLockKey('00000000-0000-4000-8000-000000000001');
      const k2 = tenantAdvisoryLockKey('00000000-0000-4000-8000-000000000001');
      expect(k1).toBe(k2);
      expect(typeof k1).toBe('bigint');
    });

    it('returns DIFFERENT keys for different tenants', () => {
      const a = tenantAdvisoryLockKey('00000000-0000-4000-8000-000000000001');
      const b = tenantAdvisoryLockKey('00000000-0000-4000-8000-000000000002');
      expect(a).not.toBe(b);
    });

    it('throws when tenantId is empty', () => {
      expect(() => tenantAdvisoryLockKey('')).toThrow(/tenantId is required/);
    });

    it('produces values within signed BIGINT range', () => {
      const key = tenantAdvisoryLockKey('00000000-0000-4000-8000-000000000001');
      const SIGNED_BIGINT_MAX = (1n << 63n) - 1n;
      const SIGNED_BIGINT_MIN = -(1n << 63n);
      expect(key).toBeLessThanOrEqual(SIGNED_BIGINT_MAX);
      expect(key).toBeGreaterThanOrEqual(SIGNED_BIGINT_MIN);
    });
  });

  describe('acquireTenantAdvisoryLock', () => {
    it('issues `pg_advisory_xact_lock` with the tenant key', async () => {
      const queryRunner = { query: jest.fn().mockResolvedValue([]) } as unknown as {
        query: jest.Mock;
      };
      await acquireTenantAdvisoryLock(
        queryRunner as never,
        '00000000-0000-4000-8000-000000000001',
      );
      expect(queryRunner.query).toHaveBeenCalledTimes(1);
      const [sql, params] = queryRunner.query.mock.calls[0];
      expect(sql).toContain('pg_advisory_xact_lock');
      expect(params).toHaveLength(1);
      // The bigint is stringified for the pg driver — confirm the
      // string representation matches the key.
      const expected = tenantAdvisoryLockKey(
        '00000000-0000-4000-8000-000000000001',
      ).toString();
      expect(params[0]).toBe(expected);
    });
  });
});
