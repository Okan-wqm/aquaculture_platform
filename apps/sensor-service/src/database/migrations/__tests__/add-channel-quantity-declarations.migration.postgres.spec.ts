import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddChannelQuantityDeclarations1820000000000 } from '../1820000000000-AddChannelQuantityDeclarations';

/**
 * The declared-quantity column and its history table on real Postgres, run the
 * way the orchestrator runs it: once per schema with the search_path pinned. A
 * tenant schema gains a nullable column without touching existing rows and an
 * empty ledger; re-running is a no-op; a schema without the channel table is
 * skipped; `down` removes both.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';

jest.setTimeout(180_000);

describe('AddChannelQuantityDeclarations1820000000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
      CREATE TABLE "${schema}".sensor_data_channels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        sensor_id uuid NOT NULL,
        channel_key varchar(100) NOT NULL,
        unit varchar(50)
      )`);
    await admin.query(
      `INSERT INTO "${schema}".sensor_data_channels (tenant_id, sensor_id, channel_key, unit)
       VALUES ($1, gen_random_uuid(), 'ammonia', 'mg/L')`,
      [TENANT],
    );
    await admin.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await admin.query(`CREATE SCHEMA "empty_schema"`);
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function inSchema(target: string, run: (qr: QueryRunner) => Promise<void>): Promise<void> {
    const qr = admin!.createQueryRunner();
    try {
      await qr.query(`SET search_path TO "${target}", public`);
      await qr.startTransaction();
      await run(qr);
      await qr.commitTransaction();
    } finally {
      await qr.release();
    }
  }

  async function column(): Promise<Array<{ is_nullable: string; data_type: string }>> {
    return admin!.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sensor_data_channels'
          AND column_name = 'declared_quantity'`,
      [schema],
    );
  }

  it('adds a nullable column and leaves existing rows undeclared, idempotently', async () => {
    const migration = new AddChannelQuantityDeclarations1820000000000();
    await inSchema(schema, (qr) => migration.up(qr));
    await inSchema(schema, (qr) => migration.up(qr));
    expect(await column()).toEqual([{ is_nullable: 'YES', data_type: 'character varying' }]);
    expect(
      await admin!.query(`SELECT declared_quantity FROM "${schema}".sensor_data_channels`),
    ).toEqual([{ declared_quantity: null }]);
  });

  it('creates an empty, insertable ledger in the tenant schema', async () => {
    await admin!.query(
      `INSERT INTO "${schema}".channel_quantity_declarations
         (tenant_id, sensor_id, channel_id, channel_key, quantity, unit, reason, declared_by)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'ammonia', 'tan', 'mg/L', 'declared', 'user-1')`,
      [TENANT],
    );
    const [row] = await admin!.query(
      `SELECT quantity, declared_at IS NOT NULL AS stamped FROM "${schema}".channel_quantity_declarations`,
    );
    expect(row).toEqual({ quantity: 'tan', stamped: true });
  });

  it('skips a schema that has no channel table', async () => {
    await expect(
      inSchema('empty_schema', (qr) => new AddChannelQuantityDeclarations1820000000000().up(qr)),
    ).resolves.toBeUndefined();
  });

  it('removes the column and the ledger on down', async () => {
    await inSchema(schema, (qr) => new AddChannelQuantityDeclarations1820000000000().down(qr));
    expect(await column()).toEqual([]);
    const [ledger] = await admin!.query(`SELECT to_regclass($1) IS NULL AS gone`, [
      `"${schema}".channel_quantity_declarations`,
    ]);
    expect(ledger).toEqual({ gone: true });
  });
});
