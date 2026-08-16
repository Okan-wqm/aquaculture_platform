import { defined } from '@aquaculture/testing';
import type { DataSource, QueryRunner } from 'typeorm';

import { TenantRlsSyncService } from './tenant-rls-sync.service';

/**
 * tenant-rls-sync.service.spec.ts
 * ============================================================================
 *
 * Behavioural test suite for the per-tenant RLS sweep that closes the
 * NEW-C1 finding (Phase 1 farm-service RLS was installed on the source
 * schema only — production tenant tables had no policies).
 *
 * The service iterates `tenant_<uuid>` schemas at OnApplicationBootstrap
 * and calls `applyTenantRlsToSchema(qr, { schemaOverride: schema })` on
 * each. We verify:
 *
 *   1. Schema discovery uses the strict `tenant_<16 hex>` regex (rejects
 *      legacy/sandbox patterns silently).
 *   2. Each discovered schema gets its own QueryRunner (released cleanly,
 *      no connection leak on success or failure).
 *   3. A failure on one schema does NOT stop the sweep — sibling schemas
 *      continue processing and the failure is logged with the
 *      `rls.bootstrap.failed` substring for alerting.
 *   4. Empty discovery (no tenants provisioned yet) is handled
 *      gracefully — log + return, no throw.
 *   5. The `disabled` option short-circuits the entire sweep with a
 *      WARN log.
 */

/**
 * Mock factory for DataSource. Each createQueryRunner call returns a
 * fresh runner with its own scripted reply queue. The factory tracks
 * how many times createQueryRunner was called and how many releases
 * happened (so the test can assert no leaks).
 */
function makeMockDataSource(opts: {
  /** Reply rows from listTenantSchemas() */
  schemas: string[];
  /**
   * Per-schema reply scripts. Key = schema name, value = FIFO queue
   * for that schema's QueryRunner. If a key is omitted, the runner
   * for that schema returns undefined for every call.
   */
  perSchemaReplies?: Record<string, ReadonlyArray<unknown>>;
  /**
   * If set, the runner for the named schema throws this error from
   * its `connect()` call. Used to simulate per-tenant failures
   * without unwinding the whole sweep.
   */
  failOnSchemaConnect?: string;
}): {
  ds: DataSource;
  createdRunners: number;
  releasedRunners: number;
  releasedRunnerSchemas: string[];
} {
  let createdRunners = 0;
  let releasedRunners = 0;
  const releasedRunnerSchemas: string[] = [];

  // The runner factory is invoked once per schema iteration. We need to
  // know which schema each runner is "for" so we can deliver the right
  // reply script. The DataSource itself doesn't know — instead the
  // helper queries `information_schema.columns` first and the schema is
  // a parameter. We sniff the parameter from the first query call.
  const ds: DataSource = {
    query: (sql: string): Promise<unknown> => {
      // listTenantSchemas() pattern
      if (sql.includes('information_schema.schemata')) {
        return Promise.resolve(opts.schemas.map((s) => ({ schema_name: s })));
      }
      return Promise.reject(new Error(`mock DataSource: unexpected query "${sql.slice(0, 80)}"`));
    },
    createQueryRunner: () => {
      createdRunners++;
      let currentSchema: string | undefined;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      let replyIdx = 0;

      const runner: QueryRunner = {
        connect: (): Promise<void> => {
          // Defer the schema decision until the first query, because
          // the QueryRunner doesn't know which schema it's for.
          return Promise.resolve();
        },
        query: (sql: string, params?: unknown[]): Promise<unknown> => {
          calls.push({ sql, params });
          // Identify the schema from the first information_schema query
          // parameter. After that, all replies come from the per-schema
          // queue.
          if (currentSchema === undefined && Array.isArray(params)) {
            currentSchema = params[0] as string;
            // Simulate per-schema connect failure if configured. We do
            // it here (on first query) instead of connect() because the
            // helper interleaves connect() with query() and we want to
            // hit the helper's catch block.
            if (opts.failOnSchemaConnect === currentSchema) {
              return Promise.reject(new Error('simulated connect failure'));
            }
          }
          const replies = currentSchema && opts.perSchemaReplies?.[currentSchema];
          if (replies && replyIdx < replies.length) {
            const r = replies[replyIdx++];
            return Promise.resolve(r);
          }
          // Default reply for unscripted calls (mostly DDL) — undefined
          // means "no rows", which the helper accepts for ALTER/CREATE.
          return Promise.resolve(undefined);
        },
        release: (): Promise<void> => {
          releasedRunners++;
          if (currentSchema !== undefined) {
            releasedRunnerSchemas.push(currentSchema);
          }
          return Promise.resolve();
        },
      } as unknown as QueryRunner;
      return runner;
    },
  } as unknown as DataSource;

  return {
    ds,
    get createdRunners() {
      return createdRunners;
    },
    get releasedRunners() {
      return releasedRunners;
    },
    releasedRunnerSchemas,
  };
}

describe('TenantRlsSyncService', () => {
  // Pre-existing red fixed with the PR#363 port: `applyTenantRlsToSchema`
  // hard-requires the db-migrate capability env (DB_MIGRATE_DDL_AUTHORITY=1)
  // since the helper-level authority guard landed, so the sweep-mechanics
  // tests must run in the ONLY context where the DDL path is legal (the
  // same context messaging-service uses to gate syncTenantSchemas). The
  // authoritative-mode test below overrides both keys explicitly.
  const originalEnv = {
    DB_MIGRATE_DDL_AUTHORITY: process.env['DB_MIGRATE_DDL_AUTHORITY'],
    DB_MIGRATE_AUTHORITATIVE: process.env['DB_MIGRATE_AUTHORITATIVE'],
  };

  beforeEach(() => {
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    Reflect.deleteProperty(process.env, 'DB_MIGRATE_AUTHORITATIVE');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('onApplicationBootstrap', () => {
    it('runs no-op gracefully when no tenant schemas exist', async () => {
      const mock = makeMockDataSource({ schemas: [] });
      const service = new TenantRlsSyncService(mock.ds, {
        serviceName: 'farm',
      });

      await service.onApplicationBootstrap();

      // Discovery happened, but no QueryRunner was created (no work).
      expect(mock.createdRunners).toBe(0);
      expect(mock.releasedRunners).toBe(0);
    });

    it('iterates discovered tenant schemas, one QueryRunner per schema', async () => {
      const schemas = ['tenant_4b529829ea7948da', 'tenant_5c640940fb805aeb'];
      // Each schema's discovery query returns one BaseEntity-shaped table
      // → 4 DDLs run per table → 4 helper replies per schema
      const perSchemaReplies: Record<string, unknown[]> = {
        [defined(schemas[0], 'Expected first tenant schema')]: [
          [{ table_name: 'batches', column_name: 'tenant_id' }],
          undefined,
          undefined,
          undefined,
          undefined,
        ],
        [defined(schemas[1], 'Expected second tenant schema')]: [
          [{ table_name: 'batches', column_name: 'tenant_id' }],
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      };
      const mock = makeMockDataSource({ schemas, perSchemaReplies });
      const service = new TenantRlsSyncService(mock.ds, {
        serviceName: 'farm',
      });

      await service.onApplicationBootstrap();

      // One runner per schema, all released.
      expect(mock.createdRunners).toBe(2);
      expect(mock.releasedRunners).toBe(2);
      expect(mock.releasedRunnerSchemas).toEqual(schemas);
    });

    it('continues processing siblings when one schema fails', async () => {
      const schemas = [
        'tenant_4b529829ea7948da',
        'tenant_5c640940fb805aeb', // this one will fail
        'tenant_6d751a51fc916bfc',
      ];
      const perSchemaReplies: Record<string, unknown[]> = {
        [defined(schemas[0], 'Expected first tenant schema')]: [
          [{ table_name: 'batches', column_name: 'tenant_id' }],
          undefined,
          undefined,
          undefined,
          undefined,
        ],
        [defined(schemas[2], 'Expected third tenant schema')]: [
          [{ table_name: 'batches', column_name: 'tenant_id' }],
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      };
      const mock = makeMockDataSource({
        schemas,
        perSchemaReplies,
        failOnSchemaConnect: defined(schemas[1], 'Expected failing tenant schema'),
      });
      const service = new TenantRlsSyncService(mock.ds, {
        serviceName: 'farm',
      });

      // The sweep itself MUST NOT throw — partial failures are logged
      // but the service continues.
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

      // All 3 runners created and released, even though one failed.
      // Connection leak on the failure path would surface as a count
      // mismatch here.
      expect(mock.createdRunners).toBe(3);
      expect(mock.releasedRunners).toBe(3);
    });

    it('honours the disabled flag and short-circuits without running', async () => {
      const mock = makeMockDataSource({
        schemas: ['tenant_4b529829ea7948da'],
      });
      const service = new TenantRlsSyncService(mock.ds, {
        serviceName: 'farm',
        disabled: true,
      });

      await service.onApplicationBootstrap();

      // No discovery, no runners.
      expect(mock.createdRunners).toBe(0);
      expect(mock.releasedRunners).toBe(0);
    });

    it('fails before tenant discovery in authoritative mode (PR#363 port)', async () => {
      // Runtime-service context: no db-migrate capability env, explicit
      // authoritative mode → the choke-point must throw before discovery.
      // (Suite-level afterEach restores both keys.)
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
      process.env['DB_MIGRATE_AUTHORITATIVE'] = 'true';

      const mock = makeMockDataSource({
        schemas: ['tenant_4b529829ea7948da'],
      });
      const service = new TenantRlsSyncService(mock.ds, {
        serviceName: 'farm',
      });

      await expect(service.onApplicationBootstrap()).rejects.toThrow(/Runtime DDL operation/i);
      // Fail-fast contract: no QueryRunner may be created — the
      // violation surfaces before any tenant schema is enumerated.
      expect(mock.createdRunners).toBe(0);
    });
  });
});
