import {
  applyTenantRlsToSchema,
  SENSOR_TENANT_ROUTE_TABLES,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { purgeTenantRoutes } from '../tenant-route-purge';

/**
 * The schema delete job's route purge on real Postgres (ADR-047,
 * SENSOR-HIGH-175). The route tables carry the FORCE RLS policy their
 * migrations apply and belong to a role that is neither superuser nor
 * BYPASSRLS, so the policy binds the purge. It deletes exactly the job
 * tenant's rows from every declared route table, keeps every other tenant's,
 * skips a route table this database does not have, and leaves no tenant
 * named in the session for the job's later writes.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';
const ABSENT = 'tenant_provisioning_key_directory';
const PRESENT = SENSOR_TENANT_ROUTE_TABLES.filter((table) => table !== ABSENT);
const OWNER = 'route_owner';

jest.setTimeout(180_000);

describe('purgeTenantRoutes', () => {
  let harness: HarnessContext;
  let owner: DataSource;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    const admin = harness.dataSource;
    await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE SCHEMA sensor AUTHORIZATION ${OWNER}`);
    for (const table of PRESENT) {
      await admin.query(
        `CREATE TABLE sensor.${table} (id serial PRIMARY KEY, tenant_id uuid NOT NULL)`,
      );
      await admin.query(`ALTER TABLE sensor.${table} OWNER TO ${OWNER}`);
      await admin.query(`INSERT INTO sensor.${table} (tenant_id) VALUES ($1), ($1), ($2), ($2)`, [
        TENANT,
        OTHER_TENANT,
      ]);
    }
    const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    const qr = admin.createQueryRunner();
    try {
      await applyTenantRlsToSchema(qr, {
        schemaOverride: 'sensor',
        tenantIdColumns: ['tenant_id'],
        includeTables: PRESENT,
      });
    } finally {
      await qr.release();
      if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
    owner = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: OWNER,
      password: OWNER,
    });
    await owner.initialize();
  });

  afterAll(async () => {
    await owner.destroy();
    await shutdownHarness(harness);
  });

  async function remaining(table: string): Promise<Array<{ tenant_id: string; rows: number }>> {
    // The superuser bypasses RLS: it sees every tenant's rows.
    return harness.dataSource.query(
      `SELECT tenant_id, COUNT(*)::int AS rows FROM sensor.${table}
        GROUP BY tenant_id ORDER BY tenant_id`,
    );
  }

  it('binds the owner: without a tenant named, a route table shows it no row', async () => {
    for (const table of PRESENT) {
      const [, deleted]: [unknown, number] = await owner.query(
        `DELETE FROM sensor.${table} WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(deleted).toBe(0);
    }
  });

  it('deletes the tenant’s routes from every present route table and only them', async () => {
    const qr = owner.createQueryRunner();
    let session: string | undefined;
    let purge: Awaited<ReturnType<typeof purgeTenantRoutes>> | undefined;
    try {
      await qr.startTransaction();
      purge = await purgeTenantRoutes(qr, TENANT);
      const rows: Array<{ tenant: string }> = await qr.query(
        `SELECT current_setting('app.current_tenant', true) AS tenant`,
      );
      session = rows[0]?.tenant;
      await qr.commitTransaction();
    } finally {
      await qr.release();
    }

    expect(purge).toEqual({
      deleted: Object.fromEntries(PRESENT.map((table) => [`sensor.${table}`, 2])),
      total: 2 * PRESENT.length,
    });
    expect(session).toBe('');
    for (const table of PRESENT) {
      expect(await remaining(table)).toEqual([{ tenant_id: OTHER_TENANT, rows: 2 }]);
    }
  });
});
