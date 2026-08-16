import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { QueryRunner } from 'typeorm';

import { EnforceStorageInventoryPhysicalKey1809700000000 } from '../../database/migrations/1809700000000-EnforceStorageInventoryPhysicalKey';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

jest.setTimeout(120_000);

describe('storage inventory physical key migration on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let queryRunner: QueryRunner | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
  });

  afterEach(async () => {
    if (queryRunner) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      await queryRunner.release();
      queryRunner = undefined;
    }
  });

  afterAll(async () => {
    if (pg) await shutdownHarness(pg);
  });

  async function startFixture(): Promise<QueryRunner> {
    if (!pg) throw new Error('Postgres harness did not start');
    queryRunner = pg.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_movements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_inventory"`);
    await queryRunner.query(`
      CREATE TABLE "storage_inventory" (
        "id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "storage_location_id" uuid NOT NULL,
        "item_type" varchar(20) NOT NULL,
        "item_id" uuid NOT NULL,
        "quantity" numeric(15,2) NOT NULL,
        "unit" varchar(20) NOT NULL,
        "lot_number" varchar(100),
        "expiry_date" date,
        "received_date" timestamptz,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_618b9a1fc23d4c400d6c91047a"
        ON "storage_inventory" (
          "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
        )
    `);
    await queryRunner.query(`
      CREATE TABLE "stock_movements" (
        "id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "movement_type" varchar(20) NOT NULL,
        "item_type" varchar(20) NOT NULL,
        "item_id" uuid NOT NULL,
        "quantity" numeric(15,2) NOT NULL,
        "lot_number" varchar(100),
        "from_location_id" uuid,
        "to_location_id" uuid,
        "performed_by" uuid NOT NULL
      )
    `);
    return queryRunner;
  }

  async function insertDuplicatePair(
    runner: QueryRunner,
    ledgerSecondQuantity = 15,
  ): Promise<void> {
    await runner.query(
      `INSERT INTO "storage_inventory" (
         "id", "tenant_id", "storage_location_id", "item_type", "item_id", "quantity",
         "unit", "lot_number", "received_date", "created_at"
       ) VALUES
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, $2, 'feed', $3, 10, 'kg', NULL,
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', $1, $2, 'feed', $3, 15, 'kg', NULL,
          '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
      [TENANT, LOCATION, ITEM],
    );
    await runner.query(
      `INSERT INTO "stock_movements" (
         "id", "tenant_id", "movement_type", "item_type", "item_id", "quantity",
         "lot_number", "to_location_id", "performed_by"
       ) VALUES
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, 'in', 'feed', $2, 10, NULL, $3, $4),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $1, 'in', 'feed', $2, $5, NULL, $3, $4)`,
      [TENANT, ITEM, LOCATION, USER, ledgerSecondQuantity],
    );
  }

  it('reconciles a ledger-proven NULL-lot duplicate and enforces one exact key on rerun', async () => {
    const runner = await startFixture();
    await insertDuplicatePair(runner);
    const migration = new EnforceStorageInventoryPhysicalKey1809700000000();

    await migration.up(runner);
    await expect(migration.postCondition(runner)).resolves.toBe(true);
    await migration.up(runner);
    await expect(migration.postCondition(runner)).resolves.toBe(true);

    const rows: Array<{ quantity: string; received_date: Date }> = await runner.query(
      `SELECT "quantity"::text AS quantity, "received_date"
         FROM "storage_inventory"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe('25.00');
    expect(rows[0]?.received_date.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    await expect(
      runner.query(
        `INSERT INTO "storage_inventory" (
           "id", "tenant_id", "storage_location_id", "item_type", "item_id", "quantity",
           "unit", "lot_number", "created_at"
         ) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', $1, $2, 'feed', $3, 1, 'kg', NULL, now())`,
        [TENANT, LOCATION, ITEM],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('refuses to merge duplicates whose projection is not proven by the immutable ledger', async () => {
    const runner = await startFixture();
    await insertDuplicatePair(runner, 14);

    await expect(new EnforceStorageInventoryPhysicalKey1809700000000().up(runner)).rejects.toThrow(
      'unproven physical keys',
    );
  });

  it('preserves unknown receipt provenance when only part of a proven group is dated', async () => {
    const runner = await startFixture();
    await insertDuplicatePair(runner);
    await runner.query(
      `UPDATE "storage_inventory"
          SET "received_date" = NULL
        WHERE "id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`,
    );

    const migration = new EnforceStorageInventoryPhysicalKey1809700000000();
    await migration.up(runner);

    const rows: Array<{ received_date: Date | null }> = await runner.query(
      `SELECT "received_date" FROM "storage_inventory"`,
    );
    expect(rows).toEqual([{ received_date: null }]);
  });

  it('rejects a concurrent second NULL-lot insert instead of splitting the projection', async () => {
    const runner = await startFixture();
    await new EnforceStorageInventoryPhysicalKey1809700000000().up(runner);
    await runner.commitTransaction();
    await runner.release();
    queryRunner = undefined;
    if (!pg) throw new Error('Postgres harness did not start');

    const first = pg.dataSource.createQueryRunner();
    const second = pg.dataSource.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    try {
      const insert = `INSERT INTO "storage_inventory" (
        "id", "tenant_id", "storage_location_id", "item_type", "item_id", "quantity",
        "unit", "lot_number", "created_at"
      ) VALUES ($1, $2, $3, 'feed', $4, 10, 'kg', NULL, now())`;
      await first.query(insert, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', TENANT, LOCATION, ITEM]);
      const competingInsert = second.query(insert, [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
        TENANT,
        LOCATION,
        ITEM,
      ]);
      await first.commitTransaction();
      await expect(competingInsert).rejects.toMatchObject({ driverError: { code: '23505' } });
      await second.rollbackTransaction();

      const rows: Array<{ row_count: string }> = await pg.dataSource.query(
        `SELECT COUNT(*)::text AS row_count FROM "storage_inventory"
          WHERE "tenant_id" = $1 AND "storage_location_id" = $2
            AND "item_type" = 'feed' AND "item_id" = $3 AND "lot_number" IS NULL`,
        [TENANT, LOCATION, ITEM],
      );
      expect(rows[0]?.row_count).toBe('1');
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }
  });
});
