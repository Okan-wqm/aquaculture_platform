import type { QueryRunner } from 'typeorm';

import {
  convertAuditColumnsToTimestamptz,
  revertAuditColumnsToTimestamp,
} from './convert-audit-columns-to-timestamptz.helper';

/**
 * convert-audit-columns-to-timestamptz.helper.spec.ts
 * ============================================================================
 *
 * Behavioural tests for the NEW-H1 fix that closes the audit-column
 * TIMESTAMP-without-timezone bug across 8 services. The helper is the
 * shared workhorse called from both per-service migrations and the
 * `AuditColumnsBootstrap` lifecycle hook, so its discovery and DDL
 * shape are the single point of truth that needs regression
 * protection.
 *
 * Coverage targets:
 *   1. Discovery only returns columns whose data type is the literal
 *      `timestamp without time zone` — already-converted columns are
 *      skipped, making re-runs idempotent at the database layer.
 *   2. The exact ALTER TABLE ... ALTER COLUMN sequence is emitted with
 *      one statement per table (multi-clause batching) so PostgreSQL
 *      rewrites each table once instead of once per column.
 *   3. `schemaOverride` skips the round-trip to `current_schema()`.
 *   4. Identifier validation rejects malicious overrides before any
 *      SQL is issued.
 *   5. Empty discovery (no qualifying columns) is a clean no-op.
 *   6. Exclusion list keeps deliberately-cross-tenant tables on the
 *      legacy type.
 *   7. Rollback (`revertAuditColumnsToTimestamp`) inverts the
 *      conversion using the timestamp-with-timezone discovery filter,
 *      so it doesn't accidentally touch unrelated columns.
 */

/**
 * Mock QueryRunner with scripted FIFO replies and a recorded call log.
 * Same shape as the RLS helper spec — duplicated to avoid cross-spec
 * dependency churn.
 */
function makeMockRunner(replies: ReadonlyArray<unknown>): {
  runner: QueryRunner;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let idx = 0;
  const runner = {
    query: (sql: string, params?: unknown[]): Promise<unknown> => {
      calls.push({ sql, params });
      if (idx >= replies.length) {
        return Promise.reject(
          new Error(
            `mock runner exhausted at call ${idx}: unexpected SQL "${sql.slice(0, 80)}..."`,
          ),
        );
      }
      return Promise.resolve(replies[idx++]);
    },
  } as unknown as QueryRunner;
  return { runner, calls };
}

describe('convertAuditColumnsToTimestamptz', () => {
  const originalEnv = {
    DB_MIGRATE_AUTHORITATIVE: process.env['DB_MIGRATE_AUTHORITATIVE'],
    DB_MIGRATE_DDL_AUTHORITY: process.env['DB_MIGRATE_DDL_AUTHORITY'],
    NODE_ENV: process.env['NODE_ENV'],
    AQUA_ENV: process.env['AQUA_ENV'],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('happy path', () => {
    it('discovers TIMESTAMP audit columns and emits one ALTER per table', async () => {
      const replies = [
        // current_schema()
        [{ schema: 'auth' }],
        // pg_settings (TimeZone audit log)
        [{ setting: 'UTC' }],
        // information_schema.columns discovery
        [
          { table_name: 'users', column_name: 'createdAt' },
          { table_name: 'users', column_name: 'updatedAt' },
          { table_name: 'invitations', column_name: 'createdAt' },
        ],
        // 2 ALTER TABLE statements (one per table)
        undefined,
        undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner);

      expect(calls.length).toBe(5);

      // Discovery query is parameterised — verify the parameters,
      // because the table-name + column-name list is the security-
      // sensitive part of the SQL we trust to information_schema's
      // catalog (no user input).
      expect(calls[2]?.sql).toMatch(/information_schema\.columns/);
      expect(calls[2]?.sql).toMatch(/timestamp without time zone/);
      expect(calls[2]?.params).toEqual([
        'auth',
        ['createdAt', 'updatedAt', 'created_at', 'updated_at'],
      ]);

      // Two-column users table → one ALTER with two clauses
      expect(calls[3]?.sql).toContain('ALTER TABLE "auth"."users"');
      expect(calls[3]?.sql).toContain('ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ');
      expect(calls[3]?.sql).toContain('ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ');
      expect(calls[3]?.sql).toContain(`USING "createdAt" AT TIME ZONE 'UTC'`);
      expect(calls[3]?.sql).toContain(`USING "updatedAt" AT TIME ZONE 'UTC'`);

      // Single-column invitations table → one ALTER with one clause
      expect(calls[4]?.sql).toContain('ALTER TABLE "auth"."invitations"');
      expect(calls[4]?.sql).toContain('ALTER COLUMN "createdAt"');
    });

    it('honours snake_case audit columns from farm-service BaseEntity', async () => {
      const replies = [
        [{ schema: 'farm' }],
        [{ setting: 'UTC' }],
        [
          { table_name: 'batches', column_name: 'created_at' },
          { table_name: 'batches', column_name: 'updated_at' },
        ],
        undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner);

      expect(calls[3]?.sql).toContain('"created_at"');
      expect(calls[3]?.sql).toContain('"updated_at"');
      expect(calls[3]?.sql).not.toContain('"createdAt"');
    });

    it('skips when discovery returns no qualifying columns', async () => {
      // The discovery query returns nothing → already-converted env.
      // No ALTER fires; helper logs and exits cleanly.
      const replies = [
        [{ schema: 'billing' }],
        [{ setting: 'UTC' }],
        [], // empty discovery
      ];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner);

      expect(calls.length).toBe(3); // schema + tz + discovery, no DDL
    });
  });

  describe('idempotency at the discovery layer', () => {
    it('discovery filters on data_type = timestamp without time zone', async () => {
      // Verify the filter exists in the SQL — this is the
      // security-critical piece that makes re-runs idempotent at the
      // database level instead of relying on application-side state.
      const replies = [[{ schema: 'sensor' }], [{ setting: 'UTC' }], []];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner);

      expect(calls[2]?.sql).toContain(`c.data_type = 'timestamp without time zone'`);
      // Negative assertion: must NOT use 'timestamptz' or 'with time
      // zone' in the discovery filter — that would invert the logic.
      expect(calls[2]?.sql).not.toContain(`'timestamptz'`);
      expect(calls[2]?.sql).not.toContain(`'timestamp with time zone'`);
    });
  });

  describe('schemaOverride', () => {
    it('uses schemaOverride and skips current_schema() round-trip', async () => {
      // No current_schema() row in the replies — if the helper queries
      // it, the mock runs out and the test fails loudly.
      const replies = [
        [{ setting: 'UTC' }], // pg_settings still fires (audit log)
        [{ table_name: 't', column_name: 'createdAt' }],
        undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner, {
        schemaOverride: 'tenant_4b529829ea7948da',
      });

      // First call should be pg_settings, not SELECT current_schema()
      expect(calls[0]?.sql).toMatch(/pg_settings/);
      // Discovery uses the overridden schema
      expect(calls[1]?.params?.[0]).toBe('tenant_4b529829ea7948da');
      // ALTER targets the overridden schema
      expect(calls[2]?.sql).toContain('"tenant_4b529829ea7948da"."t"');
    });

    it('rejects a malicious schemaOverride before any SQL is issued', async () => {
      const { runner, calls } = makeMockRunner([]);

      await expect(
        convertAuditColumnsToTimestamptz(runner, {
          schemaOverride: 'auth; DROP DATABASE postgres',
        }),
      ).rejects.toThrow(/Unsafe SQL identifier for schemaOverride/);

      expect(calls.length).toBe(0);
    });
  });

  describe('exclusion list', () => {
    it('skips tables in excludeTables', async () => {
      const replies = [
        [{ schema: 'farm' }],
        [{ setting: 'UTC' }],
        [
          { table_name: 'batches', column_name: 'createdAt' },
          { table_name: 'farm_outbox', column_name: 'createdAt' },
        ],
        // Only one ALTER expected (excludes farm_outbox)
        undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner, {
        excludeTables: ['farm_outbox'],
      });

      // 3 reads + 1 ALTER (only batches)
      expect(calls.length).toBe(4);
      expect(calls[3]?.sql).toContain('"farm"."batches"');
      expect(calls[3]?.sql).not.toContain('farm_outbox');
    });
  });

  describe('custom auditColumns option', () => {
    it('honours non-default audit column names', async () => {
      const replies = [
        [{ schema: 'legacy' }],
        [{ setting: 'UTC' }],
        [{ table_name: 't', column_name: 'inserted_at' }],
        undefined,
      ];
      const { runner, calls } = makeMockRunner(replies);

      await convertAuditColumnsToTimestamptz(runner, {
        auditColumns: ['inserted_at', 'modified_at'],
      });

      expect(calls[2]?.params).toEqual(['legacy', ['inserted_at', 'modified_at']]);
    });
  });

  describe('db-migrate authority boundary', () => {
    it('refuses production-authoritative DDL without db-migrate authority before issuing SQL', async () => {
      process.env['DB_MIGRATE_AUTHORITATIVE'] = 'true';
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
      const { runner, calls } = makeMockRunner([]);

      await expect(convertAuditColumnsToTimestamptz(runner)).rejects.toThrow(
        /db-migrate authority/,
      );

      expect(calls).toHaveLength(0);
    });
  });
});

describe('revertAuditColumnsToTimestamp', () => {
  it('discovery filters on data_type = timestamp with time zone', async () => {
    const replies = [
      [{ schema: 'auth' }],
      [], // empty discovery — nothing to revert
    ];
    const { runner, calls } = makeMockRunner(replies);

    await revertAuditColumnsToTimestamp(runner);

    // Inverse of up(): only revert what we previously converted
    expect(calls[1]?.sql).toContain(`c.data_type = 'timestamp with time zone'`);
  });

  it('emits ALTER ... TYPE TIMESTAMP USING ... AT TIME ZONE UTC', async () => {
    const replies = [
      [{ schema: 'auth' }],
      [
        { table_name: 'users', column_name: 'createdAt' },
        { table_name: 'users', column_name: 'updatedAt' },
      ],
      undefined,
    ];
    const { runner, calls } = makeMockRunner(replies);

    await revertAuditColumnsToTimestamp(runner);

    expect(calls[2]?.sql).toContain('TYPE TIMESTAMP USING');
    expect(calls[2]?.sql).toContain(`AT TIME ZONE 'UTC'`);
    // NOT TIMESTAMPTZ — this is the rollback path
    expect(calls[2]?.sql).not.toMatch(/TYPE TIMESTAMPTZ\b/);
  });
});
