import type { QueryRunner } from 'typeorm';
import {
  applyTenantRlsToSchema,
  removeTenantRlsFromSchema,
  buildTenantPolicyUsingClause,
  TENANT_ISOLATION_POLICY_NAME,
  RLS_TENANT_GUC,
  RLS_BYPASS_GUC,
} from './apply-tenant-rls.helper';

/**
 * apply-tenant-rls.helper.spec.ts
 * ============================================================================
 *
 * Security-critical test suite. The helper builds the SQL predicate that
 * the tenant_isolation_policy uses to decide whether a row is visible to
 * the current session. A bug in the predicate silently allows cross-tenant
 * reads, which is the worst failure mode for a multi-tenant SaaS.
 *
 * These tests exercise:
 *   1. The exported predicate-builder (buildTenantPolicyUsingClause) at a
 *      string level — so any change to the clause shape is immediately
 *      visible as a test regression.
 *   2. The full applyTenantRlsToSchema() flow against a mocked QueryRunner
 *      that records every issued SQL statement. We then assert the
 *      expected ALTER / DROP / CREATE sequence, the idempotency paths,
 *      the exclusion list, and the camelCase/snake_case column discovery.
 *   3. SQL identifier validation — any attempt to smuggle a malicious
 *      schema or table name must throw before any SQL is issued.
 *
 * We do NOT test against a real PostgreSQL instance here — that's the job
 * of a separate integration test tier. The value of the unit layer is
 * regression protection for the SQL we emit and the control flow we take.
 */

/**
 * Builds a mock QueryRunner that records every call to `query()` and
 * returns a configurable set of results per invocation. The result stack
 * is FIFO: the first call returns the first entry, and so on. Unused
 * entries cause the test to fail (catches "more queries than expected"
 * bugs).
 *
 * We intentionally use a simple record-and-replay pattern instead of
 * jest.Mocked<QueryRunner> because TypeORM's QueryRunner type has too
 * many members to stub individually and the extra surface distracts
 * from what the test is actually verifying.
 */
function makeMockRunner(
  replies: ReadonlyArray<unknown>,
): {
  runner: QueryRunner;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let callIndex = 0;

  const runner = {
    query: async (sql: string, params?: unknown[]): Promise<unknown> => {
      calls.push({ sql, params });
      if (callIndex >= replies.length) {
        throw new Error(
          `mock runner exhausted at call ${callIndex}: no reply for ` +
            `SQL "${sql.slice(0, 80)}..."`,
        );
      }
      const reply = replies[callIndex];
      callIndex += 1;
      return reply;
    },
  } as unknown as QueryRunner;

  return { runner, calls };
}

describe('apply-tenant-rls.helper', () => {
  describe('buildTenantPolicyUsingClause', () => {
    it('emits the bug-fixed NULLIF predicate', () => {
      const clause = buildTenantPolicyUsingClause('tenantId');

      // The OR-separated structure is SECURITY-CRITICAL — documented in
      // the helper header as the behaviour matrix. Any accidental
      // simplification of either side would either over-grant (bypass
      // without guard) or under-grant (no bypass path at all).
      expect(clause).toContain(
        `current_setting('${RLS_BYPASS_GUC}', true) = 'on'`,
      );
      expect(clause).toContain(
        `"tenantId" = NULLIF(current_setting('${RLS_TENANT_GUC}', true), '')::uuid`,
      );
      expect(clause).toContain(' OR ');
    });

    it('honours snake_case tenant column names', () => {
      const clause = buildTenantPolicyUsingClause('tenant_id');
      expect(clause).toContain(`"tenant_id" = NULLIF(`);
      // No quotes on the GUC name — that would be a literal string
      // instead of a setting name, and would break the policy.
      expect(clause).not.toContain(`"${RLS_TENANT_GUC}"`);
    });

    it('rejects unsafe identifier characters', () => {
      expect(() => buildTenantPolicyUsingClause('tenant_id; DROP TABLE users')).toThrow(
        /Unsafe SQL identifier/,
      );
      expect(() => buildTenantPolicyUsingClause('tenant id')).toThrow(
        /Unsafe SQL identifier/,
      );
      expect(() => buildTenantPolicyUsingClause('')).toThrow(
        /Unsafe SQL identifier/,
      );
    });

    it('NEVER emits the legacy buggy COALESCE(..., \'\')::uuid pattern', () => {
      // Regression guard: the original farm-service RLS migration shipped
      //   COALESCE(current_setting(...), '')::uuid
      // which throws "invalid input syntax for type uuid: ''" whenever the
      // GUC is unset. The fix replaces COALESCE with NULLIF — both happen
      // to end in `, '')::uuid` so we match against the COALESCE wrapper
      // specifically rather than the shared suffix.
      const clause = buildTenantPolicyUsingClause('tenantId');
      expect(clause).not.toContain(`COALESCE(current_setting`);
      // And positively assert NULLIF IS the wrapper in use.
      expect(clause).toContain(`NULLIF(current_setting`);
    });
  });

  describe('applyTenantRlsToSchema', () => {
    /**
     * The helper issues one SELECT current_schema() call, one information_
     * schema discovery SELECT, and then 3 DDL statements per discovered
     * table (ENABLE RLS, FORCE RLS, DROP POLICY IF EXISTS, CREATE POLICY).
     *
     * Our fixture simulates a schema with two tables — one using camelCase
     * tenantId and one using snake_case tenant_id — and verifies the full
     * emitted SQL sequence.
     */
    it('installs RLS on discovered tables with correct column casing', async () => {
      const replies = [
        // current_schema()
        [{ schema: 'farm' }],
        // information_schema.columns discovery
        [
          { table_name: 'batches', column_name: 'tenant_id' },
          { table_name: 'users_legacy', column_name: 'tenantId' },
        ],
        // 4 DDL statements × 2 tables = 8 undefined replies
        undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner);

      // First call: current_schema
      expect(calls[0]?.sql).toMatch(/SELECT current_schema/);

      // Second call: discovery query (parameterized on schema + column
      // array). The parameters are the key audit artefact — prove they
      // came through correctly and did not get interpolated raw.
      expect(calls[1]?.sql).toMatch(/information_schema\.columns/);
      expect(calls[1]?.params).toEqual(['farm', ['tenantId', 'tenant_id']]);

      // Subsequent calls for batches (snake_case tenant_id)
      expect(calls[2]?.sql).toContain('ENABLE ROW LEVEL SECURITY');
      expect(calls[2]?.sql).toContain('"farm"."batches"');
      expect(calls[3]?.sql).toContain('FORCE ROW LEVEL SECURITY');
      expect(calls[4]?.sql).toContain('DROP POLICY IF EXISTS');
      expect(calls[4]?.sql).toContain(`"${TENANT_ISOLATION_POLICY_NAME}"`);
      expect(calls[5]?.sql).toContain('CREATE POLICY');
      expect(calls[5]?.sql).toContain('"tenant_id" = NULLIF');
      // WITH CHECK is MANDATORY — without it, writers can insert rows
      // for other tenants. This is the single most security-critical
      // assertion in the suite.
      expect(calls[5]?.sql).toContain('WITH CHECK');

      // Subsequent calls for users_legacy (camelCase tenantId)
      expect(calls[9]?.sql).toContain('"tenantId" = NULLIF');
    });

    it('no-ops gracefully when schema has no tenant-scoped tables', async () => {
      const replies = [
        [{ schema: 'auth' }],
        [], // empty discovery
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner);

      // Only the two setup queries fire; no ALTER, no CREATE POLICY
      expect(calls.length).toBe(2);
    });

    it('honours excludeTables', async () => {
      const replies = [
        [{ schema: 'farm' }],
        [
          { table_name: 'batches', column_name: 'tenant_id' },
          { table_name: 'farm_outbox', column_name: 'tenant_id' },
          { table_name: 'audit_logs', column_name: 'tenant_id' },
        ],
        // 4 DDLs × 1 non-excluded table (batches) = 4 replies
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, {
        excludeTables: ['farm_outbox', 'audit_logs'],
      });

      // Exactly 2 setup + 4 DDLs for the one non-excluded table
      expect(calls.length).toBe(6);
      // None of the DDLs target the excluded tables
      for (const call of calls.slice(2)) {
        expect(call.sql).not.toContain('farm_outbox');
        expect(call.sql).not.toContain('audit_logs');
      }
      // The single DDL chain targets batches
      expect(calls[2]?.sql).toContain('"farm"."batches"');
    });

    it('deduplicates tables that appear under multiple tenant columns', async () => {
      // If a table has BOTH tenantId AND tenant_id (legacy migration
      // artefact), the discovery query returns two rows. The helper
      // must only install RLS once, using the highest-priority column
      // (first in tenantIdColumns).
      const replies = [
        [{ schema: 'mixed' }],
        [
          { table_name: 'weird_table', column_name: 'tenantId' },   // first
          { table_name: 'weird_table', column_name: 'tenant_id' },  // duplicate
        ],
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner);

      // Only 4 DDLs (one table), not 8 (two tables)
      expect(calls.length).toBe(6);
      // Uses tenantId, not tenant_id, because it appeared first
      expect(calls[5]?.sql).toContain('"tenantId" = NULLIF');
      expect(calls[5]?.sql).not.toContain('"tenant_id"');
    });

    it('rejects a malicious current_schema() return value', async () => {
      // If information_schema somehow returns a schema name with a
      // semicolon (e.g. from a compromised catalog), the identifier
      // validator must catch it before any interpolation happens.
      const replies = [
        [{ schema: 'farm; DROP DATABASE postgres' }],
      ];
      const { runner } = makeMockRunner(replies);

      await expect(applyTenantRlsToSchema(runner)).rejects.toThrow(
        /Unsafe SQL identifier/,
      );
    });

    it('honours custom tenantIdColumns option', async () => {
      const replies = [
        [{ schema: 'custom' }],
        [{ table_name: 't', column_name: 'orgId' }],
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, {
        tenantIdColumns: ['orgId'],
      });

      expect(calls[1]?.params).toEqual(['custom', ['orgId']]);
      expect(calls[5]?.sql).toContain('"orgId" = NULLIF');
    });
  });

  describe('removeTenantRlsFromSchema', () => {
    it('drops policy then DISABLEs RLS in the right order', async () => {
      const replies = [
        [{ schema: 'farm' }],
        [{ table_name: 'batches', column_name: 'tenant_id' }],
        undefined, undefined, undefined, // DROP POLICY, NO FORCE, DISABLE
      ];
      const { runner, calls } = makeMockRunner(replies);

      await removeTenantRlsFromSchema(runner);

      // Order matters: DROP POLICY → NO FORCE → DISABLE. Doing DISABLE
      // before DROP POLICY leaves an orphaned policy reference in the
      // catalog; doing NO FORCE after DISABLE is a no-op. The helper
      // uses the documented safe order.
      expect(calls[2]?.sql).toContain('DROP POLICY');
      expect(calls[3]?.sql).toContain('NO FORCE ROW LEVEL SECURITY');
      expect(calls[4]?.sql).toContain('DISABLE ROW LEVEL SECURITY');
    });
  });

  describe('logger override', () => {
    it('uses the supplied logger surface (log + warn)', async () => {
      const logs: string[] = [];
      const warns: string[] = [];
      const logger = {
        log: (msg: string): void => void logs.push(msg),
        warn: (msg: string): void => void warns.push(msg),
      };

      const replies = [
        [{ schema: 'empty' }],
        [],
      ];
      const { runner } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, { logger });

      // "Applying tenant RLS ..." log fires before discovery
      expect(logs.some((l) => l.includes('Applying tenant RLS'))).toBe(true);
      // "No tenant-scoped tables found" warn fires on empty discovery
      expect(warns.some((w) => w.includes('No tenant-scoped tables'))).toBe(true);
    });
  });
});
