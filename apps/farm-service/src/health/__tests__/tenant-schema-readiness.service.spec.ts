/**
 * TenantSchemaReadinessService Unit Tests
 *
 * Proves the farm-service tenant-schema-routing readiness slice:
 *   - healthy topology (source core tables + sampled tenant populated) -> 'ok'
 *   - missing source core table                                        -> 'error' (fail closed)
 *   - sampled tenant schema missing core tables                        -> 'error' (fail closed)
 *   - zero tenant schemas (fresh install)                              -> 'ok'
 *   - uninitialized DataSource                                         -> 'error'
 *   - failing query                                                    -> 'error' (NOT a thrown 500)
 *
 * DataSource is mocked via createMockDataSource() from @aquaculture/testing.
 * We re-program the mock's `query` per-SQL so a single mock drives every
 * topology scenario deterministically, with no real database.
 */

import { Logger } from '@nestjs/common';
import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';
import { createMockDataSource } from '@aquaculture/testing';

import { TenantSchemaReadinessService } from '../tenant-schema-readiness.service';

/** Anchor core tables the service samples in both source and tenant schemas. */
const CORE_TABLES = ['farms', 'sites', 'ponds', 'tanks', 'batches_v2'] as const;

interface QueryScenario {
  /** Tables present in the `farm` source schema. */
  sourceTables: readonly string[];
  /** Sample tenant schema name, or null for "no tenants provisioned". */
  sampleTenant: string | null;
  /** Tables present in the sample tenant schema (ignored when sampleTenant null). */
  tenantTables: readonly string[];
}

const ALL_CORE = CORE_TABLES;

/**
 * Build a `query` implementation that answers the three SQL shapes the service
 * issues: (1) source/tenant table-count aggregate, (2) tenant-schema sample
 * listing. Counts are computed against the scenario's table sets.
 */
function makeQueryImpl(
  scenario: QueryScenario,
): (sql: string, params?: unknown[]) => Promise<unknown> {
  return (sql: string, params?: unknown[]): Promise<unknown> => {
    if (sql.includes('information_schema.schemata')) {
      // getSampleTenantSchema()
      return Promise.resolve(
        scenario.sampleTenant === null ? [] : [{ schema_name: scenario.sampleTenant }],
      );
    }
    if (sql.includes('information_schema.tables')) {
      // countExistingTables(schema, expectedTables)
      const schema = params?.[0] as string;
      const expected = (params?.[1] as string[]) ?? [];
      const present =
        schema === 'farm'
          ? scenario.sourceTables
          : schema === scenario.sampleTenant
            ? scenario.tenantTables
            : [];
      const count = expected.filter((t) => present.includes(t)).length;
      return Promise.resolve([{ count: String(count) }]);
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
}

function buildService(
  scenario: QueryScenario,
  opts: { isInitialized?: boolean } = {},
): {
  service: TenantSchemaReadinessService;
  queryMock: jest.Mock;
} {
  const { mockDataSource } = createMockDataSource();
  const queryMock = jest.fn();
  mockDataSource.query = queryMock as typeof mockDataSource.query;
  queryMock.mockImplementation(makeQueryImpl(scenario));

  // createMockDataSource() does not stub isInitialized; the controller/service
  // reads it, so define it explicitly for the readiness path.
  Object.defineProperty(mockDataSource, 'isInitialized', {
    value: opts.isInitialized ?? true,
    configurable: true,
  });

  const service = new TenantSchemaReadinessService(mockDataSource);
  return { service, queryMock };
}

describe('TenantSchemaReadinessService', () => {
  // The service logs the failure cause on every fail-closed path (by design —
  // a DOWN readiness must explain why). Silence the logger so the deliberate
  // error stacks don't pollute the test runner output.
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('healthy topology', () => {
    it('returns "ok" when source schema and sampled tenant both have core tables', async () => {
      const { service } = buildService({
        sourceTables: ALL_CORE,
        sampleTenant: 'tenant_0123456789abcdef',
        tenantTables: ALL_CORE,
      });

      await expect(service.checkTenantSchemaRouting()).resolves.toBe('ok');
    });

    it('returns "ok" on a fresh install with zero tenant schemas (nothing to sync)', async () => {
      const { service, queryMock } = buildService({
        sourceTables: ALL_CORE,
        sampleTenant: null,
        tenantTables: [],
      });

      await expect(service.checkTenantSchemaRouting()).resolves.toBe('ok');
      // It must have probed the source AND attempted the tenant listing,
      // then short-circuited (no tenant table-count query for a sample).
      const sqls = queryMock.mock.calls.map((c) => c[0] as string);
      expect(sqls.some((s) => s.includes('information_schema.tables'))).toBe(true);
      expect(sqls.some((s) => s.includes('information_schema.schemata'))).toBe(true);
    });
  });

  describe('fail-closed: broken topology reports DOWN (not a thrown 500)', () => {
    it('returns "error" when the farm SOURCE schema is missing a core table', async () => {
      const { service } = buildService({
        sourceTables: ['farms', 'sites', 'ponds', 'tanks'], // missing batches_v2
        sampleTenant: 'tenant_0123456789abcdef',
        tenantTables: ALL_CORE,
      });

      await expect(service.checkTenantSchemaRouting()).resolves.toBe('error');
    });

    it('returns "error" when the sampled TENANT schema is missing core tables', async () => {
      const { service } = buildService({
        sourceTables: ALL_CORE,
        sampleTenant: 'tenant_0123456789abcdef',
        tenantTables: ['farms'], // sync fan-out incomplete
      });

      await expect(service.checkTenantSchemaRouting()).resolves.toBe('error');
    });

    it('returns "error" (not throw) when a query rejects', async () => {
      const { service, queryMock } = buildService({
        sourceTables: ALL_CORE,
        sampleTenant: 'tenant_0123456789abcdef',
        tenantTables: ALL_CORE,
      });
      queryMock.mockRejectedValue(new Error('connection refused'));

      // Must resolve to 'error', never reject — a thrown error would surface
      // as an opaque 500 that hides the cause from the K8s probe.
      await expect(service.checkTenantSchemaRouting()).resolves.toBe('error');
    });

    it('returns "error" when the DataSource is not initialized', async () => {
      const { service, queryMock } = buildService(
        { sourceTables: ALL_CORE, sampleTenant: null, tenantTables: [] },
        { isInitialized: false },
      );

      await expect(service.checkTenantSchemaRouting()).resolves.toBe('error');
      // Short-circuits before issuing any topology query.
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  describe('SSoT anchoring', () => {
    it('only probes farm core tables that are declared in MODULE_SCHEMAS', async () => {
      const farmModule = MODULE_SCHEMAS.find((m) => m.moduleName === 'farm');
      expect(farmModule).toBeDefined();
      // The anchor sample set must be a subset of the declared farm tables, so
      // the check never asserts on a table the SSoT does not own.
      for (const t of CORE_TABLES) {
        expect(farmModule?.tables).toContain(t);
      }
    });

    it('passes the SSoT-intersected core table list as the $2 ANY(...) bind', async () => {
      const { service, queryMock } = buildService({
        sourceTables: ALL_CORE,
        sampleTenant: null,
        tenantTables: [],
      });

      await service.checkTenantSchemaRouting();

      const sourceCall = queryMock.mock.calls.find(
        (c) => (c[0] as string).includes('information_schema.tables'),
      );
      expect(sourceCall?.[1]?.[0]).toBe('farm');
      expect(sourceCall?.[1]?.[1]).toEqual([...CORE_TABLES]);
    });
  });
});
