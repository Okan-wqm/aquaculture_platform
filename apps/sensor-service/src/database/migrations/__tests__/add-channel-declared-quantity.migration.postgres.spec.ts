import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddChannelDeclaredQuantity1820000000000 } from '../1820000000000-AddChannelDeclaredQuantity';

/**
 * The declared-quantity column on real Postgres, run the way the orchestrator
 * runs it: once per schema with the search_path pinned. A tenant schema gains
 * a nullable column without touching existing rows; re-running is a no-op; a
 * schema without the table is skipped; `down` removes the column.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';

jest.setTimeout(180_000);

describe('AddChannelDeclaredQuantity1820000000000', () => {
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
    const migration = new AddChannelDeclaredQuantity1820000000000();
    await inSchema(schema, (qr) => migration.up(qr));
    await inSchema(schema, (qr) => migration.up(qr));
    expect(await column()).toEqual([{ is_nullable: 'YES', data_type: 'character varying' }]);
    expect(
      await admin!.query(`SELECT declared_quantity FROM "${schema}".sensor_data_channels`),
    ).toEqual([{ declared_quantity: null }]);
  });

  it('skips a schema that has no channel table', async () => {
    await expect(
      inSchema('empty_schema', (qr) => new AddChannelDeclaredQuantity1820000000000().up(qr)),
    ).resolves.toBeUndefined();
  });

  it('removes the column on down', async () => {
    await inSchema(schema, (qr) => new AddChannelDeclaredQuantity1820000000000().down(qr));
    expect(await column()).toEqual([]);
  });
});
