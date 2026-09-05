import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';

import {
  backfillTenantLedger,
  findMissingPerTenantTables,
  perTenantTablesFor,
} from '../tenant-ledger-backfill';

/**
 * INFRA-CRITICAL-149 — a deploy may seed a tenant's `migrations_<src>` ledger
 * from the source history ONLY when the tenant schema demonstrably carries the
 * source's per-tenant tables. The executor is scripted (the module works on
 * any `.query`), so the stamping decision is pinned without a live database;
 * the same module runs unchanged against PostgreSQL in the db-migration-check
 * lane, where the provisioning gate leaves a real tenant behind.
 */

const TENANT = 'tenant_7f6b08ab90e246d3';
const SOURCE = 'farm';
const SOURCE_ROWS = 41;

interface Issued {
  sql: string;
  params?: readonly unknown[];
}

function scriptedExecutor(state: { ledgerRows: number; tenantTables: readonly string[] }): {
  executor: { query(sql: string, params?: readonly unknown[]): Promise<unknown> };
  issued: Issued[];
} {
  const issued: Issued[] = [];
  const executor = {
    query(sql: string, params?: readonly unknown[]): Promise<unknown> {
      issued.push({ sql, ...(params !== undefined ? { params } : {}) });
      if (sql.includes('SELECT COUNT(*)::text AS count')) {
        return Promise.resolve([{ count: String(state.ledgerRows) }]);
      }
      if (sql.includes('FROM information_schema.tables')) {
        return Promise.resolve(state.tenantTables.map((table_name) => ({ table_name })));
      }
      return Promise.resolve([]);
    },
  };
  return { executor, issued };
}

const isStamp = (entry: Issued): boolean =>
  entry.sql.includes(`INSERT INTO "${TENANT}"."migrations_${SOURCE}"`);

describe('perTenantTablesFor', () => {
  it('is the registry set the provisioning gate asserts — tables plus reference data', () => {
    const farm = MODULE_SCHEMAS.find((module) => module.sourceSchema === SOURCE);
    if (farm === undefined) throw new Error('MODULE_SCHEMAS lost its farm entry');
    expect(perTenantTablesFor(SOURCE)).toEqual([
      ...new Set([...farm.tables, ...(farm.referenceDataTables ?? [])]),
    ]);
    expect(perTenantTablesFor(SOURCE).length).toBeGreaterThan(50);
  });

  it('never includes a cross-tenant infrastructure table', () => {
    for (const module of MODULE_SCHEMAS) {
      const perTenant = new Set(perTenantTablesFor(module.sourceSchema));
      for (const table of module.infrastructureTables ?? []) {
        expect(perTenant.has(table)).toBe(false);
      }
    }
  });

  it('refuses a source schema the registry does not describe', () => {
    expect(() => perTenantTablesFor('not_a_module')).toThrow(/MODULE_SCHEMAS has no entry/);
  });
});

describe('findMissingPerTenantTables', () => {
  it('reports exactly the registry tables absent from the tenant schema, sorted', async () => {
    const expected = perTenantTablesFor(SOURCE);
    const absent = [expected[0], expected[expected.length - 1]].sort();
    const present = expected.filter((table) => !absent.includes(table));
    const { executor, issued } = scriptedExecutor({ ledgerRows: 0, tenantTables: present });

    await expect(findMissingPerTenantTables(executor, SOURCE, TENANT)).resolves.toEqual(absent);
    expect(issued[0]?.params).toEqual([TENANT]);
  });
});

describe('backfillTenantLedger (INFRA-CRITICAL-149)', () => {
  it('stamps the source history when the tenant carries every per-tenant table', async () => {
    const { executor, issued } = scriptedExecutor({
      ledgerRows: 0,
      tenantTables: perTenantTablesFor(SOURCE),
    });

    const outcome = await backfillTenantLedger(executor, {
      sourceSchema: SOURCE,
      tenantSchema: TENANT,
      sourceRows: SOURCE_ROWS,
    });

    expect(outcome).toEqual({
      tenantSchema: TENANT,
      tenantLedger: `migrations_${SOURCE}`,
      serviceRole: 'farm_service',
      skipped: false,
      copiedRows: SOURCE_ROWS,
    });
    expect(issued.filter(isStamp)).toHaveLength(1);
    expect(issued.some((entry) => entry.sql.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(
      issued.some((entry) =>
        entry.sql.includes(`GRANT SELECT ON TABLE "${TENANT}"."migrations_${SOURCE}"`),
      ),
    ).toBe(true);
  });

  it('leaves the ledger empty — and says which tables are missing — when the schema is partial', async () => {
    // The shape the live gate actually left behind: this source's tables are
    // absent while another service's are present. The old "no tables at all"
    // idea passes this schema and stamps it; the per-source rule must not.
    const expected = perTenantTablesFor(SOURCE);
    const present = expected.slice(0, Math.floor(expected.length / 2));
    const { executor, issued } = scriptedExecutor({ ledgerRows: 0, tenantTables: present });

    const outcome = await backfillTenantLedger(executor, {
      sourceSchema: SOURCE,
      tenantSchema: TENANT,
      sourceRows: SOURCE_ROWS,
    });

    expect(outcome).toEqual({
      tenantSchema: TENANT,
      tenantLedger: `migrations_${SOURCE}`,
      serviceRole: 'farm_service',
      skipped: true,
      copiedRows: 0,
      reason: 'missing-per-tenant-tables',
      missingTables: expected.slice(Math.floor(expected.length / 2)).sort(),
    });
    expect(issued.filter(isStamp)).toHaveLength(0);
  });

  it('refuses to stamp an empty schema at all', async () => {
    const { executor, issued } = scriptedExecutor({ ledgerRows: 0, tenantTables: [] });

    const outcome = await backfillTenantLedger(executor, {
      sourceSchema: SOURCE,
      tenantSchema: TENANT,
      sourceRows: SOURCE_ROWS,
    });

    expect(outcome.skipped).toBe(true);
    expect(outcome.skipped && outcome.reason).toBe('missing-per-tenant-tables');
    expect(issued.filter(isStamp)).toHaveLength(0);
  });

  it('leaves a populated ledger alone without probing the tables', async () => {
    const { executor, issued } = scriptedExecutor({ ledgerRows: 12, tenantTables: [] });

    const outcome = await backfillTenantLedger(executor, {
      sourceSchema: SOURCE,
      tenantSchema: TENANT,
      sourceRows: SOURCE_ROWS,
    });

    expect(outcome).toEqual({
      tenantSchema: TENANT,
      tenantLedger: `migrations_${SOURCE}`,
      serviceRole: 'farm_service',
      skipped: true,
      copiedRows: 0,
      reason: 'ledger-populated',
    });
    expect(issued.filter(isStamp)).toHaveLength(0);
    expect(issued.some((entry) => entry.sql.includes('FROM information_schema.tables'))).toBe(
      false,
    );
  });

  it('refuses a schema name outside the tenant namespace before touching it', async () => {
    const { executor, issued } = scriptedExecutor({ ledgerRows: 0, tenantTables: [] });

    await expect(
      backfillTenantLedger(executor, {
        sourceSchema: SOURCE,
        tenantSchema: 'public',
        sourceRows: SOURCE_ROWS,
      }),
    ).rejects.toThrow(/Refusing unsafe tenant schema/);
    expect(issued).toHaveLength(0);
  });
});
