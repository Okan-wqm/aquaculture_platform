import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddSensorPlacedAt1825000000000 } from '../1825000000000-AddSensorPlacedAt';

/**
 * The placed-at column on real Postgres, run the way the orchestrator runs it:
 * once per schema with the search_path pinned. A tenant schema gains a
 * nullable column without touching existing rows; re-running is a no-op; a
 * schema without the sensors table is skipped; `down` removes it.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';

jest.setTimeout(180_000);

describe('AddSensorPlacedAt1825000000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
      CREATE TABLE "${schema}".sensors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id varchar
      )`);
    await admin.query(
      `INSERT INTO "${schema}".sensors (tenant_id, site_id) VALUES ($1, 'site-1')`,
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
        WHERE table_schema = $1 AND table_name = 'sensors' AND column_name = 'placed_at'`,
      [schema],
    );
  }

  it('adds a nullable column and leaves existing rows unplaced, idempotently', async () => {
    const migration = new AddSensorPlacedAt1825000000000();
    await inSchema(schema, (qr) => migration.up(qr));
    await inSchema(schema, (qr) => migration.up(qr));
    expect(await column()).toEqual([{ is_nullable: 'YES', data_type: 'timestamp with time zone' }]);
    expect(await admin!.query(`SELECT placed_at FROM "${schema}".sensors`)).toEqual([
      { placed_at: null },
    ]);
  });

  it('skips a schema that has no sensors table', async () => {
    await expect(
      inSchema('empty_schema', (qr) => new AddSensorPlacedAt1825000000000().up(qr)),
    ).resolves.toBeUndefined();
  });

  it('removes the column on down', async () => {
    await inSchema(schema, (qr) => new AddSensorPlacedAt1825000000000().down(qr));
    expect(await column()).toEqual([]);
  });
});
