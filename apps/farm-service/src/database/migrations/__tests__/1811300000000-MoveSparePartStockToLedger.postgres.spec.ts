/**
 * MoveSparePartStockToLedger1811300000000 against a REAL PostgreSQL
 * (FARM-HIGH-338).
 *
 * ## Why this suite has to hit a real database
 *
 * The migration is four SQL statements whose correctness lives entirely in
 * Postgres semantics a mocked QueryRunner cannot evaluate: the ranked
 * code-then-name match with its uniqueness rule, the tenant and soft-delete
 * predicates of that match, the fail-closed listing of unplaceable stock, and
 * the exactly-once import that leans on two `ON CONFLICT` arbiters — the
 * `stock_movements` partial unique index `(tenant_id, idempotency_key) WHERE
 * idempotency_key IS NOT NULL` and the `storage_inventory` canonical key
 * `(tenant_id, storage_location_id, item_type, item_id, COALESCE(lot_number,
 * ''))`. An `ON CONFLICT` whose arbiter index does not exist is a hard error,
 * so both are built here exactly as production builds them.
 *
 * ## Shape
 *
 * `synchronize` builds the tables from the entities; `spare_parts` then loses
 * the `storageLocationId` column the migration adds, so every case starts from
 * the PRE-migration shape (and is reset to it before each case). Spare parts
 * are seeded with raw SQL for the same reason: the entity already describes
 * the post-migration column, the table does not have it yet.
 *
 * Each `up()` runs the way the migration runner runs it
 * (`migration-runner.service.ts`): one transaction, `postCondition()` inside
 * it, commit on success, roll back on a throw or a false post-condition.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, QueryRunner } from 'typeorm';

import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { SparePart } from '../../../maintenance/entities/spare-part.entity';
import { StockMovement } from '../../../storage/entities/stock-movement.entity';
import { StorageInventory } from '../../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../../storage/entities/storage-location.entity';
import { Supplier } from '../../../supplier/entities/supplier.entity';
import {
  LEGACY_QUANTITY_FREEZE_TRIGGER,
  MoveSparePartStockToLedger1811300000000,
} from '../1811300000000-MoveSparePartStockToLedger';
import { RestoreStorageInventoryCanonicalKey1809700000000 } from '../1809700000000-RestoreStorageInventoryCanonicalKey';

const TENANT = '3f6c2a1e-8b4d-4c7a-9e2f-1a2b3c4d5e6f';
const OTHER_TENANT = '7d1e9c3b-2a4f-4b6d-8c1e-9f8e7d6c5b4a';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MIGRATION_ACTOR = '00000000-0000-0000-0000-000000000000';

interface PartSeed {
  name: string;
  quantity: number;
  /** `location->>'warehouse'`; omitted = the jsonb carries no warehouse key. */
  warehouse?: string;
  /** true = the whole `location` jsonb is NULL. */
  noLocation?: boolean;
  tenantId?: string;
}

interface SeededPart {
  id: string;
  name: string;
}

interface LocationSeed {
  code: string;
  name: string;
  siteId?: string;
  tenantId?: string;
  isDeleted?: boolean;
}

describe('MoveSparePartStockToLedger1811300000000 — real Postgres (FARM-HIGH-338)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let partSeq = 0;
  const migration = new MoveSparePartStockToLedger1811300000000();

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-spare-part-ledger-migration-${randomBytes(4).toString('hex')}`,
      // The four tables the migration touches, plus SparePart's relation
      // closure (EquipmentType, Supplier): TypeORM builds metadata only when
      // every relation TARGET is registered.
      entities: [
        SparePart,
        Supplier,
        EquipmentType,
        StorageLocation,
        StorageInventory,
        StockMovement,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();

    // stock_movements: the tenant-scoped idempotency arbiter, spelled exactly
    // as 1800400000000-CreateFarmStockReadModel / 1800600000000-
    // ExtendFarmStockReadModelFanout create it in production (the baseline's
    // global index is dropped there). The synchronize-built twin is dropped
    // first so the index under test is the production statement, not the
    // entity decorator's rendering of it.
    await dataSource.query(`
      DROP INDEX IF EXISTS "idx_stock_movements_tenant_idempotency";
      DROP INDEX IF EXISTS "IDX_93018beb62439a265dcb715936";
      DROP INDEX IF EXISTS "IDX_stock_movements_idempotency_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_stock_movements_tenant_idempotency"
        ON stock_movements ("tenant_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
    // storage_inventory: the canonical key, from its own migration.
    await runInTransaction((queryRunner) =>
      new RestoreStorageInventoryCanonicalKey1809700000000().up(queryRunner),
    );
  });

  beforeEach(async () => {
    // Back to the pre-migration shape: dropping the column takes the FK and
    // the (tenantId, storageLocationId) index the migration created with it;
    // the legacy-quantity freeze trigger (V-B1-7) goes too, so a case can
    // seed pre-migration counters again.
    await dataSource.query(
      `DROP TRIGGER IF EXISTS ${LEGACY_QUANTITY_FREEZE_TRIGGER} ON "farm"."spare_parts"`,
    );
    await dataSource.query(
      'ALTER TABLE "farm"."spare_parts" DROP COLUMN IF EXISTS "storageLocationId"',
    );
    await dataSource.query(
      'TRUNCATE "farm"."spare_parts", "farm"."stock_movements", "farm"."storage_inventory", "farm"."storage_locations"',
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  // ── runner + probes ───────────────────────────────────────────────────────

  async function runInTransaction(
    work: (queryRunner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await work(queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * One migration pass the way the runner applies it: up() and
   * postCondition() in one transaction; a throw or a false probe rolls back.
   * Returns the probe's verdict.
   */
  async function runLikeRunner(): Promise<boolean> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await migration.up(queryRunner);
      const holds = await migration.postCondition(queryRunner);
      if (holds) await queryRunner.commitTransaction();
      else await queryRunner.rollbackTransaction();
      return holds;
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async function postConditionNow(): Promise<boolean> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      return await migration.postCondition(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  async function storageLocationColumnExists(): Promise<boolean> {
    const rows: Array<{ present: boolean }> = await dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'farm'
            AND table_name = 'spare_parts'
            AND column_name = 'storageLocationId'
       ) AS present`,
    );
    return rows[0]?.present === true;
  }

  async function placementOf(partId: string): Promise<string | null> {
    const rows: Array<{ location: string | null }> = await dataSource.query(
      `SELECT "storageLocationId"::text AS location FROM "farm"."spare_parts" WHERE id = $1`,
      [partId],
    );
    return rows[0]?.location ?? null;
  }

  // ── seed helpers ──────────────────────────────────────────────────────────

  async function seedLocation(seed: LocationSeed): Promise<string> {
    const id = randomUUID();
    await dataSource.manager.save(StorageLocation, {
      id,
      tenantId: seed.tenantId ?? TENANT,
      siteId: seed.siteId ?? SITE_A,
      code: seed.code,
      name: seed.name,
      usedCapacity: 0,
      isDeleted: seed.isDeleted ?? false,
    });
    return id;
  }

  /** Raw INSERT: the table is in its pre-migration shape, the entity is not. */
  async function seedPart(seed: PartSeed): Promise<SeededPart> {
    partSeq += 1;
    const id = randomUUID();
    const location = seed.noLocation
      ? null
      : JSON.stringify(
          seed.warehouse === undefined
            ? { shelf: 'S1' }
            : { warehouse: seed.warehouse, shelf: 'S1' },
        );
    await dataSource.query(
      `INSERT INTO "farm"."spare_parts"
         ("id", "tenantId", "name", "code", "partNumber", "quantity", "unit", "location", "version")
       VALUES ($1, $2, $3, $4, $5, $6, 'piece', $7::jsonb, 1)`,
      [
        id,
        seed.tenantId ?? TENANT,
        seed.name,
        `SP-${partSeq}`,
        `PN-${partSeq}`,
        seed.quantity,
        location,
      ],
    );
    return { id, name: seed.name };
  }

  // ── cases ─────────────────────────────────────────────────────────────────

  it('applies to an empty spare_parts table and the post-condition holds', async () => {
    // SCENARIO: no spare parts at all.
    // EXPECTS: up() commits, postCondition() is true, the nullable
    // storageLocationId column, its FK and its index exist, and nothing was
    // written to the ledger.
    await expect(runLikeRunner()).resolves.toBe(true);

    expect(await storageLocationColumnExists()).toBe(true);
    const constraints: Array<{ conname: string }> = await dataSource.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'FK_spare_parts_storage_location'`,
    );
    expect(constraints).toHaveLength(1);
    const indexes: Array<{ indexname: string }> = await dataSource.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'farm' AND indexname = 'IDX_spare_parts_tenant_storage_location'`,
    );
    expect(indexes).toHaveLength(1);
    expect(await dataSource.manager.count(StockMovement)).toBe(0);
    expect(await dataSource.manager.count(StorageInventory)).toBe(0);
  });

  it('places parts by code (case-insensitive) or unique name and imports each quantity exactly once', async () => {
    // SCENARIO: "Impeller" says warehouse 'wh-main' — the CODE of the main
    // warehouse (spelled 'WH-MAIN') and also the NAME of a decoy location.
    // "Seal kit" says 'cold store' — the unique NAME of 'Cold store' at site
    // B. The migration is then run a second time.
    // EXPECTS: Impeller → main warehouse (a code match outranks a name
    // match), Seal kit → cold store; one 'in' movement per part keyed
    // 'sp-migrate-<id>' carrying the part's quantity, and one inventory row
    // per part at that location. The second run adds no movement and does
    // not double the inventory.
    const main = await seedLocation({ code: 'WH-MAIN', name: 'Main warehouse' });
    const decoy = await seedLocation({ code: 'DECOY', name: 'wh-main' });
    const cold = await seedLocation({ code: 'COLD-1', name: 'Cold store', siteId: SITE_B });
    const impeller = await seedPart({ name: 'Impeller', quantity: 12, warehouse: 'wh-main' });
    const sealKit = await seedPart({ name: 'Seal kit', quantity: 4, warehouse: 'cold store' });

    await expect(runLikeRunner()).resolves.toBe(true);

    expect(await placementOf(impeller.id)).toBe(main);
    expect(await placementOf(impeller.id)).not.toBe(decoy);
    expect(await placementOf(sealKit.id)).toBe(cold);

    const expectLedger = async (): Promise<void> => {
      const movements = await dataSource.manager.find(StockMovement, {
        order: { itemName: 'ASC' },
      });
      expect(movements).toHaveLength(2);
      expect(movements[0]).toMatchObject({
        tenantId: TENANT,
        movementType: 'in',
        itemType: 'spare_part',
        itemId: impeller.id,
        itemName: 'Impeller',
        quantity: 12,
        unit: 'piece',
        toLocationId: main,
        idempotencyKey: `sp-migrate-${impeller.id}`,
        performedBy: MIGRATION_ACTOR,
      });
      expect(movements[0]?.fromLocationId).toBeNull();
      expect(movements[1]).toMatchObject({
        itemId: sealKit.id,
        itemName: 'Seal kit',
        quantity: 4,
        toLocationId: cold,
        idempotencyKey: `sp-migrate-${sealKit.id}`,
      });

      const inventory = await dataSource.manager.find(StorageInventory, {
        order: { quantity: 'DESC' },
      });
      expect(inventory).toHaveLength(2);
      expect(inventory[0]).toMatchObject({
        tenantId: TENANT,
        storageLocationId: main,
        itemType: 'spare_part',
        itemId: impeller.id,
        quantity: 12,
        unit: 'piece',
      });
      expect(inventory[0]?.lotNumber).toBeNull();
      expect(inventory[1]).toMatchObject({
        storageLocationId: cold,
        itemId: sealKit.id,
        quantity: 4,
      });
    };

    await expectLedger();

    await expect(runLikeRunner()).resolves.toBe(true);

    await expectLedger();
  });

  it('fails closed on stock it cannot place, names every such part, and imports nothing', async () => {
    // SCENARIO: "Bearing" holds 5 and names no warehouse; "Pump seal" holds 3
    // and names 'spare room', which is the name of TWO locations; "Filter"
    // holds 9 and is placeable by code 'OK-1'.
    // EXPECTS: up() throws; the message lists Bearing's and Pump seal's id
    // and name and not Filter's; after the runner's rollback there is no
    // movement, no inventory row and no storageLocationId column — Filter was
    // not imported either.
    await seedLocation({ code: 'A-1', name: 'Spare room' });
    await seedLocation({ code: 'B-1', name: 'Spare room', siteId: SITE_B });
    await seedLocation({ code: 'OK-1', name: 'Ok store' });
    const bearing = await seedPart({ name: 'Bearing', quantity: 5 });
    const pumpSeal = await seedPart({ name: 'Pump seal', quantity: 3, warehouse: 'spare room' });
    const filter = await seedPart({ name: 'Filter', quantity: 9, warehouse: 'OK-1' });

    const failure = await runLikeRunner().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('2 spare part(s)');
    expect(message).toContain(`${bearing.id} (${bearing.name})`);
    expect(message).toContain(`${pumpSeal.id} (${pumpSeal.name})`);
    expect(message).not.toContain(filter.id);

    expect(await dataSource.manager.count(StockMovement)).toBe(0);
    expect(await dataSource.manager.count(StorageInventory)).toBe(0);
    expect(await storageLocationColumnExists()).toBe(false);
  });

  it('matches only live locations of the owning tenant', async () => {
    // SCENARIO: "Valve" names 'SHARED', a code only ANOTHER tenant has;
    // "Gasket" names 'OLD', a code of this tenant's soft-deleted location.
    // A third part of the other tenant names 'SHARED' and is placeable.
    // EXPECTS: up() throws listing Valve and Gasket (neither predicate lets a
    // foreign or closed location hold this tenant's stock) and not the other
    // tenant's part.
    await seedLocation({ code: 'SHARED', name: 'Shared yard', tenantId: OTHER_TENANT });
    await seedLocation({ code: 'OLD', name: 'Old shed', isDeleted: true });
    const valve = await seedPart({ name: 'Valve', quantity: 2, warehouse: 'SHARED' });
    const gasket = await seedPart({ name: 'Gasket', quantity: 6, warehouse: 'OLD' });
    const foreignPart = await seedPart({
      name: 'Foreign valve',
      quantity: 1,
      warehouse: 'SHARED',
      tenantId: OTHER_TENANT,
    });

    const failure = await runLikeRunner().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('2 spare part(s)');
    expect(message).toContain(`${valve.id} (${valve.name})`);
    expect(message).toContain(`${gasket.id} (${gasket.name})`);
    expect(message).not.toContain(foreignPart.id);
    expect(await dataSource.manager.count(StockMovement)).toBe(0);
  });

  it('leaves a part with no stock and no location alone', async () => {
    // SCENARIO: "Spare fuse" holds 0 and has no location at all.
    // EXPECTS: up() commits, postCondition() is true, the part stays
    // unplaced, and no movement or inventory row is written for it.
    const fuse = await seedPart({ name: 'Spare fuse', quantity: 0, noLocation: true });

    await expect(runLikeRunner()).resolves.toBe(true);

    expect(await placementOf(fuse.id)).toBeNull();
    expect(await dataSource.manager.count(StockMovement)).toBe(0);
    expect(await dataSource.manager.count(StorageInventory)).toBe(0);
  });

  it('post-condition reports a stocked part whose opening movement is missing', async () => {
    // SCENARIO: one placeable part is imported, then its opening movement is
    // deleted behind the migration's back.
    // EXPECTS: postCondition() is true after the import and false once the
    // movement is gone — the probe has teeth.
    await seedLocation({ code: 'WS-1', name: 'Workshop' });
    await seedPart({ name: 'Drive belt', quantity: 3, warehouse: 'ws-1' });

    await expect(runLikeRunner()).resolves.toBe(true);
    expect(await postConditionNow()).toBe(true);

    await dataSource.query(`DELETE FROM "farm"."stock_movements"`);

    expect(await postConditionNow()).toBe(false);
  });

  // ── V-B1-7: the legacy counter is frozen from the snapshot on ─────────────

  async function openingQuantity(partId: string): Promise<number | null> {
    const rows: Array<{ quantity: string }> = await dataSource.query(
      `SELECT "quantity"::text AS quantity FROM "farm"."stock_movements"
        WHERE "idempotency_key" = $1`,
      [`sp-migrate-${partId}`],
    );
    return rows[0] === undefined ? null : Number(rows[0].quantity);
  }

  it('freezes the legacy counter: a changing write is refused, the ORM and a default insert pass', async () => {
    // SCENARIO: after the migration an OLD release updates a part's counter, and
    // creates a part with an opening quantity; the NEW code creates and renames a
    // part through the entity (legacyQuantity is insert:false / update:false).
    // EXPECTS: both old writes fail with the freeze error; the new-code writes and
    // a default (0) insert pass; the post-condition requires the trigger.
    await seedLocation({ code: 'WS-2', name: 'Workshop 2' });
    const belt = await seedPart({ name: 'V-belt', quantity: 3, warehouse: 'WS-2' });
    await expect(runLikeRunner()).resolves.toBe(true);

    await expect(
      dataSource.query(
        `UPDATE "farm"."spare_parts" SET "quantity" = "quantity" - 1 WHERE id = $1`,
        [belt.id],
      ),
    ).rejects.toThrow(/spare_parts\.quantity is frozen/);
    await expect(seedPart({ name: 'Old-release part', quantity: 5 })).rejects.toThrow(
      /spare_parts\.quantity is frozen/,
    );
    await expect(seedPart({ name: 'Zero part', quantity: 0 })).resolves.toBeDefined();

    const created = await dataSource.manager.save(SparePart, {
      tenantId: TENANT,
      code: `SP-NEW-${partSeq}`,
      name: 'New-code part',
      partNumber: `PN-NEW-${partSeq}`,
      unit: 'piece',
    });
    await dataSource.manager.save(SparePart, { ...created, name: 'New-code part (renamed)' });
    expect(await openingQuantity(belt.id)).toBe(3);

    await dataSource.query(
      `DROP TRIGGER ${LEGACY_QUANTITY_FREEZE_TRIGGER} ON "farm"."spare_parts"`,
    );
    expect(await postConditionNow()).toBe(false);
  });

  it('imports a write the old release committed before the snapshot, and refuses the next one', async () => {
    // SCENARIO: the old farm-service has an UPDATE of a part's counter (4 → 7) in
    // flight when db-migrate starts (selective deploy: the old container still
    // serves). EXPECTS: the migration waits on the table lock instead of reading
    // around the write; once the write commits the opening movement carries 7;
    // the old release's next write is refused — no write is lost in between.
    await seedLocation({ code: 'WS-3', name: 'Workshop 3' });
    const impeller = await seedPart({ name: 'Old impeller', quantity: 4, warehouse: 'WS-3' });
    const oldRelease = dataSource.createQueryRunner();
    await oldRelease.connect();
    await oldRelease.startTransaction();
    await oldRelease.query(`UPDATE "farm"."spare_parts" SET "quantity" = 7 WHERE id = $1`, [
      impeller.id,
    ]);

    let migrated = false;
    const migration = runLikeRunner().then((holds) => {
      migrated = true;
      return holds;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const migratedBeforeCommit = migrated;
    await oldRelease.commitTransaction();
    await oldRelease.release();

    expect(migratedBeforeCommit).toBe(false);
    await expect(migration).resolves.toBe(true);
    expect(await openingQuantity(impeller.id)).toBe(7);
    await expect(
      dataSource.query(`UPDATE "farm"."spare_parts" SET "quantity" = 8 WHERE id = $1`, [
        impeller.id,
      ]),
    ).rejects.toThrow(/spare_parts\.quantity is frozen/);
  });
});
