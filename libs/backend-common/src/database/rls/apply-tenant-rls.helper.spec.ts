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
    query: (sql: string, params?: unknown[]): Promise<unknown> => {
      calls.push({ sql, params });
      if (callIndex >= replies.length) {
        throw new Error(
          `mock runner exhausted at call ${callIndex}: no reply for ` +
            `SQL "${sql.slice(0, 80)}..."`,
        );
      }
      const reply = replies[callIndex];
      callIndex += 1;
      return Promise.resolve(reply);
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

  /**
   * `applyTenantRlsToSchema` and `removeTenantRlsFromSchema` issue DDL, and DDL
   * authority belongs to the aqua-db-migrate provisioner: both call
   * `assertDbMigrateDdlAuthority()`, which throws unless `DB_MIGRATE_DDL_AUTHORITY`
   * is '1'. A suite that exercises the SQL those functions emit must therefore
   * declare the same authority db-migrate declares, exactly as the sibling
   * suites `infrastructure-ledger-rls.helper.spec.ts` and
   * `tenant-rls-sync.service.spec.ts` already do.
   *
   * Restore-on-teardown rather than a blanket set, so the guard's default
   * (deny) is what the `refuses to run without db-migrate DDL authority`
   * describe below observes.
   */
  const AUTHORITY_ENV = 'DB_MIGRATE_DDL_AUTHORITY';
  const originalAuthority = process.env[AUTHORITY_ENV];

  function grantDdlAuthority(): void {
    process.env[AUTHORITY_ENV] = '1';
  }

  function restoreDdlAuthority(): void {
    if (originalAuthority === undefined) Reflect.deleteProperty(process.env, AUTHORITY_ENV);
    else process.env[AUTHORITY_ENV] = originalAuthority;
  }

  /**
   * The guard is the only thing stopping a runtime service from reshaping RLS on
   * a live tenant schema, and NOTHING pinned it — the suite below drove the DDL
   * path exclusively, so removing the guard entirely would not have failed a
   * single test. It is pinned here for both functions.
   */
  describe('refuses to run without db-migrate DDL authority', () => {
    beforeEach(restoreDdlAuthority);
    afterEach(restoreDdlAuthority);

    it('applyTenantRlsToSchema throws before issuing any SQL', async () => {
      Reflect.deleteProperty(process.env, AUTHORITY_ENV);
      const { runner, calls } = makeMockRunner([]);

      await expect(applyTenantRlsToSchema(runner)).rejects.toThrow(
        /db-migrate authority/,
      );
      expect(calls).toEqual([]);
    });

    it('removeTenantRlsFromSchema throws before issuing any SQL', async () => {
      Reflect.deleteProperty(process.env, AUTHORITY_ENV);
      const { runner, calls } = makeMockRunner([]);

      await expect(removeTenantRlsFromSchema(runner)).rejects.toThrow(
        /db-migrate authority/,
      );
      expect(calls).toEqual([]);
    });
  });

  describe('applyTenantRlsToSchema', () => {
    beforeEach(grantDdlAuthority);
    afterEach(restoreDdlAuthority);

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
          { table_name: 'batches', column_name: 'tenant_id', udt_name: 'uuid' },
          { table_name: 'users_legacy', column_name: 'tenantId', udt_name: 'uuid' },
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
          { table_name: 'batches', column_name: 'tenant_id', udt_name: 'uuid' },
          { table_name: 'farm_outbox', column_name: 'tenant_id', udt_name: 'uuid' },
          { table_name: 'audit_logs', column_name: 'tenant_id', udt_name: 'uuid' },
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
          { table_name: 'weird_table', column_name: 'tenantId', udt_name: 'uuid' },   // first
          { table_name: 'weird_table', column_name: 'tenant_id', udt_name: 'uuid' },  // duplicate
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
        [{ table_name: 't', column_name: 'orgId', udt_name: 'uuid' }],
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, {
        tenantIdColumns: ['orgId'],
      });

      expect(calls[1]?.params).toEqual(['custom', ['orgId']]);
      expect(calls[5]?.sql).toContain('"orgId" = NULLIF');
    });

    it('honours includeTables for migration-scoped RLS installation', async () => {
      const replies = [
        [{ schema: 'farm' }],
        [
          {
            table_name: 'farm_stock_batch_snapshots',
            column_name: 'tenantId',
            udt_name: 'uuid',
          },
        ],
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, {
        includeTables: ['farm_stock_batch_snapshots'],
      });

      expect(calls[1]?.sql).toContain('c.table_name = ANY($3::text[])');
      expect(calls[1]?.params).toEqual([
        'farm',
        ['tenantId', 'tenant_id'],
        ['farm_stock_batch_snapshots'],
      ]);
      expect(calls.filter((call) => call.sql.includes('"farm"."farm_stock_batch_snapshots"'))).toHaveLength(4);
    });

    it('skips TimescaleDB columnstore hypertables only in tenant schemas', async () => {
      const logs: string[] = [];
      const warns: string[] = [];
      const logger = {
        log: (msg: string): void => void logs.push(msg),
        warn: (msg: string): void => void warns.push(msg),
      };
      const replies = [
        [{ schema: 'tenant_7f6b08ab90e246d3' }],
        [
          {
            table_name: 'farm_stock_batch_snapshots',
            column_name: 'tenantId',
            udt_name: 'uuid',
          },
          {
            table_name: 'sensor_metrics',
            column_name: 'tenant_id',
            udt_name: 'uuid',
          },
        ],
        [{ column_name: 'columnstore_enabled' }],
        [{ table_name: 'sensor_metrics' }],
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, { logger });

      expect(calls.filter((call) => call.sql.includes('"tenant_7f6b08ab90e246d3"."farm_stock_batch_snapshots"'))).toHaveLength(4);
      expect(calls.filter((call) => call.sql.includes('"tenant_7f6b08ab90e246d3"."sensor_metrics"'))).toHaveLength(0);
      expect(warns.some((warn) => warn.includes('TimescaleDB columnstore hypertable') && warn.includes('sensor_metrics'))).toBe(true);
      expect(logs.some((log) => log.includes('skipped: 1'))).toBe(true);
    });
  });

  describe('removeTenantRlsFromSchema', () => {
    beforeEach(grantDdlAuthority);
    afterEach(restoreDdlAuthority);

    it('drops policy then DISABLEs RLS in the right order', async () => {
      const replies = [
        [{ schema: 'farm' }],
        [{ table_name: 'batches', column_name: 'tenant_id', udt_name: 'uuid' }],
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
    beforeEach(grantDdlAuthority);
    afterEach(restoreDdlAuthority);

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

  describe('identity-table auto-skip (DEPLOY-CRITICAL-006 regression guard)', () => {
    beforeEach(grantDdlAuthority);
    afterEach(restoreDdlAuthority);

    /**
     * Tier-1 "make impossible" invariant — the helper MUST never install
     * tenant_isolation_policy on `users` or `tenants` in ANY schema,
     * regardless of caller config. A regression here would immediately
     * re-break login across the platform (users table) OR tenant status
     * checks (tenants table).
     *
     * The 2026-04-21 incident had auth-service register
     * RlsModule.forPoolService({ autoApply: true }) without listing
     * `users` in excludeTables. The policy got installed; login broke
     * for every tenant. This test guards against the code path that
     * allowed it.
     */
    it('skips auth.users even when caller forgets to exclude it', async () => {
      const logs: string[] = [];
      const warns: string[] = [];
      const logger = {
        log: (msg: string): void => void logs.push(msg),
        warn: (msg: string): void => void warns.push(msg),
      };

      const replies = [
        [{ schema: 'auth' }],
        [
          // Discovery returns users alongside a legitimately RLS-gated table.
          { table_name: 'users', column_name: 'tenantId', udt_name: 'uuid' },
          { table_name: 'invitations', column_name: 'tenantId', udt_name: 'uuid' },
        ],
        // 4 DDL statements × 1 non-skipped table (invitations) = 4 replies
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, { logger });

      // users was skipped → no DDL against auth.users
      const usersDdl = calls.filter((c) => c.sql.includes('"auth"."users"'));
      expect(usersDdl).toHaveLength(0);

      // invitations got the full DDL sequence (4 statements)
      const invitationsDdl = calls.filter((c) =>
        c.sql.includes('"auth"."invitations"'),
      );
      expect(invitationsDdl.length).toBe(4);
      expect(invitationsDdl[0]?.sql).toContain('ENABLE ROW LEVEL SECURITY');
      expect(invitationsDdl[3]?.sql).toContain('CREATE POLICY');

      // The skip was WARN-logged with the reason — operators see it in
      // deploy audits; alerts can grep the "IDENTITY-PRIMITIVE" substring.
      const skipWarn = warns.find((w) => w.includes('IDENTITY-PRIMITIVE'));
      expect(skipWarn).toBeDefined();
      expect(skipWarn).toContain('users');
      expect(skipWarn).toContain('auth');
    });

    it('skips tenants table with the same guard', async () => {
      const logs: string[] = [];
      const warns: string[] = [];
      const logger = {
        log: (msg: string): void => void logs.push(msg),
        warn: (msg: string): void => void warns.push(msg),
      };

      const replies = [
        [{ schema: 'billing' }],
        [
          { table_name: 'tenants', column_name: 'tenantId', udt_name: 'uuid' },
          { table_name: 'subscriptions', column_name: 'tenantId', udt_name: 'uuid' },
        ],
        // 4 DDL × 1 table = 4 replies
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, { logger });

      const tenantsDdl = calls.filter((c) => c.sql.includes('"billing"."tenants"'));
      expect(tenantsDdl).toHaveLength(0);

      const subsDdl = calls.filter((c) =>
        c.sql.includes('"billing"."subscriptions"'),
      );
      expect(subsDdl.length).toBe(4);

      expect(warns.some((w) => w.includes('IDENTITY-PRIMITIVE') && w.includes('tenants'))).toBe(true);
    });

    it('auto-skip applies even when excludeTables is non-empty (combined)', async () => {
      // Defense-in-depth: the identity-table skip is independent of
      // excludeTables. A caller that excludes outbox but forgets users
      // still gets users skipped.
      const logs: string[] = [];
      const warns: string[] = [];
      const logger = {
        log: (msg: string): void => void logs.push(msg),
        warn: (msg: string): void => void warns.push(msg),
      };

      const replies = [
        [{ schema: 'auth' }],
        [
          { table_name: 'users', column_name: 'tenantId', udt_name: 'uuid' },
          { table_name: 'auth_outbox', column_name: 'tenantId', udt_name: 'uuid' },
          { table_name: 'refresh_tokens', column_name: 'tenantId', udt_name: 'uuid' },
        ],
        // 4 DDL × 1 non-skipped table (refresh_tokens)
        undefined, undefined, undefined, undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await applyTenantRlsToSchema(runner, {
        logger,
        excludeTables: ['auth_outbox'],
      });

      // Zero DDL on users (identity skip) and zero on outbox (explicit skip)
      expect(calls.filter((c) => c.sql.includes('"users"')).length).toBe(0);
      expect(calls.filter((c) => c.sql.includes('"auth_outbox"')).length).toBe(0);
      // Full DDL sequence on refresh_tokens
      expect(
        calls.filter((c) => c.sql.includes('"refresh_tokens"')).length,
      ).toBe(4);
    });
  });
});
