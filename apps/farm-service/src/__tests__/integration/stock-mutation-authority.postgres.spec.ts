import 'reflect-metadata';
import {
  getTenantSchemaName,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { MovementType, StockMovement } from '../../storage/entities/stock-movement.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import {
  StorageLocation,
  StorageLocationType,
} from '../../storage/entities/storage-location.entity';
import { StorageLotMix } from '../../storage/entities/storage-lot-mix.entity';
import { LotMixService } from '../../storage/services/lot-mix.service';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { createFarmOutboxTable } from '../e2e/helpers/tenant-schema-harness';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FEED = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const DESTINATION = '66666666-6666-4666-8666-666666666666';

jest.setTimeout(120_000);

describe('StockMovementService authority on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let schemaName: string;
  let authority: StockMovementService;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createFarmOutboxTable(pg.dataSource);
    schemaName = getTenantSchemaName(TENANT);
    await pg.dataSource.query(`CREATE SCHEMA "${schemaName}"`);
    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: schemaName,
      schema: schemaName,
      entities: [
        Feed,
        Supplier,
        StorageLocation,
        StorageInventory,
        StockMovement,
        StorageLotMix,
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: { options: `-c search_path=${schemaName},farm,public` },
    });
    await dataSource.initialize();
    authority = new StockMovementService(
      new LotMixService(),
      new SiteAuthorizationService(),
      new OutboxPublisher(FarmOutbox),
      new StockMutationLockAuthority(),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (pg) {
      await pg.dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await shutdownHarness(pg);
    }
  });

  beforeEach(async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    await dataSource.query(`TRUNCATE TABLE
      "stock_movements", "storage_inventory", "storage_lot_mixes",
      "storage_locations", "feeds", "suppliers" CASCADE`);
    await dataSource.query(`TRUNCATE TABLE "farm"."outbox_events"`);

    const feedRepo = tenantManagerRepo(dataSource.manager, Feed, TENANT);
    await feedRepo.save(
      feedRepo.create({
        id: FEED,
        tenantId: TENANT,
        name: 'Canonical Grower',
        code: 'CANONICAL-GROWER',
        type: FeedType.GROWER,
        floatingType: FloatingType.FLOATING,
        status: FeedStatus.AVAILABLE,
        quantity: 0,
        minStock: 10,
        unit: 'kg',
        currency: 'EUR',
        isActive: true,
        isDeleted: false,
      }),
    );
    const locationRepo = tenantManagerRepo(dataSource.manager, StorageLocation, TENANT);
    await Promise.all(
      [
        locationRepo.create({
          id: SOURCE,
          tenantId: TENANT,
          siteId: SITE,
          name: 'Source silo',
          code: 'SOURCE',
          type: StorageLocationType.FEED_SILO,
          capacityUnit: 'kg',
          usedCapacity: 0,
          isActive: true,
          isDeleted: false,
        }),
        locationRepo.create({
          id: DESTINATION,
          tenantId: TENANT,
          siteId: SITE,
          name: 'Destination silo',
          code: 'DESTINATION',
          type: StorageLocationType.FEED_SILO,
          capacityUnit: 'kg',
          usedCapacity: 0,
          isActive: true,
          isDeleted: false,
        }),
      ].map((location) => locationRepo.save(location)),
    );
  });

  it('locks and cascades a site-scoped FEFO deduction across multiple lots atomically', async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    const inventoryRepo = tenantManagerRepo(dataSource.manager, StorageInventory, TENANT);
    await Promise.all(
      [
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 0.3,
          unit: 'kg',
          lotNumber: 'LOT-A',
          expiryDate: new Date('2026-09-01'),
          receivedDate: new Date('2026-01-01T00:00:00Z'),
        }),
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 3000,
          unit: 'kg',
          lotNumber: 'LOT-B',
          expiryDate: new Date('2026-10-01'),
          receivedDate: new Date('2026-01-02T00:00:00Z'),
        }),
      ].map((inventory) => inventoryRepo.save(inventory)),
    );

    const result = await runInTenantTransaction(
      dataSource,
      'farm',
      TENANT,
      (_queryRunner, session) =>
        authority.recordFeedDeduction(
          session,
          {
            feedId: FEED,
            quantityKg: 150,
            asOf: new Date('2026-08-01T08:00:00Z'),
            siteId: SITE,
            reference: 'FEEDING:test',
            reason: 'Real PostgreSQL FEFO proof',
            idempotencyKey: 'feeding-deduct-real-pg',
            allocationFamilyKey: 'feeding-deduct-real-pg',
          },
          { tenantId: TENANT, userId: USER },
        ),
    );

    expect(result.movements.map((movement) => Number(movement.quantity))).toEqual([0.3, 149.7]);
    expect(result.movements.map((movement) => movement.lotNumber)).toEqual(['LOT-A', 'LOT-B']);
    expect(await inventoryRepo.count({ where: { tenantId: TENANT, itemId: FEED } })).toBe(1);
    expect(
      Number(
        (await inventoryRepo.findOneOrFail({ where: { tenantId: TENANT, itemId: FEED } })).quantity,
      ),
    ).toBe(2850.3);
    expect(
      Number(
        (
          await tenantManagerRepo(dataSource.manager, Feed, TENANT).findOneOrFail({
            where: { id: FEED },
          })
        ).quantity,
      ),
    ).toBe(2850.3);
    expect(await tenantManagerRepo(dataSource.manager, StockMovement, TENANT).count()).toBe(2);
    expect(await tenantManagerRepo(dataSource.manager, FarmOutbox, TENANT).count()).toBe(2);
  });

  it('keeps a depleted feed permanently tracked and fails the next deduction closed', async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    const inventoryRepo = tenantManagerRepo(dataSource.manager, StorageInventory, TENANT);
    await inventoryRepo.save(
      inventoryRepo.create({
        tenantId: TENANT,
        storageLocationId: SOURCE,
        itemType: StorageItemType.FEED,
        itemId: FEED,
        quantity: 1,
        unit: 'kg',
        lotNumber: 'LAST-LOT',
        expiryDate: new Date('2026-12-01'),
        receivedDate: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    await runInTenantTransaction(dataSource, 'farm', TENANT, (_queryRunner, session) =>
      authority.recordFeedDeduction(
        session,
        {
          feedId: FEED,
          quantityKg: 1,
          asOf: new Date('2026-08-01T08:00:00Z'),
          reference: 'FEEDING:deplete',
          reason: 'Deplete tracked feed',
          idempotencyKey: 'feeding-deduct-deplete',
          allocationFamilyKey: 'feeding-deduct-deplete',
        },
        { tenantId: TENANT, userId: USER },
      ),
    );
    expect(await inventoryRepo.count()).toBe(0);

    await expect(
      runInTenantTransaction(dataSource, 'farm', TENANT, (_queryRunner, session) =>
        authority.recordFeedDeduction(
          session,
          {
            feedId: FEED,
            quantityKg: 0.01,
            asOf: new Date('2026-08-01T09:00:00Z'),
            reference: 'FEEDING:after-depletion',
            reason: 'Must fail closed',
            idempotencyKey: 'feeding-deduct-after-depletion',
            allocationFamilyKey: 'feeding-deduct-after-depletion',
          },
          { tenantId: TENANT, userId: USER },
        ),
      ),
    ).rejects.toThrow('Insufficient feed stock');
  });

  it('reverses a composite feeding allocation to its exact immutable lots without inventing a physical mix', async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    const inventoryRepo = tenantManagerRepo(dataSource.manager, StorageInventory, TENANT);
    const receivedA = new Date('2026-01-01T00:00:00.000Z');
    const receivedB = new Date('2026-01-02T00:00:00.000Z');
    await Promise.all(
      [
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 0.3,
          unit: 'kg',
          lotNumber: 'LOT-A',
          expiryDate: new Date('2026-09-01'),
          receivedDate: receivedA,
        }),
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 149.7,
          unit: 'kg',
          lotNumber: 'LOT-B',
          expiryDate: new Date('2026-10-01'),
          receivedDate: receivedB,
        }),
        // A resident third lot proves that a normal inbound movement would
        // create MIX-* provenance. A logical correction must instead unwind
        // the exact immutable OUT slices because the corrected quantity was
        // never physically consumed.
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 10,
          unit: 'kg',
          lotNumber: 'LOT-RESIDENT',
          expiryDate: new Date('2026-12-01'),
          receivedDate: new Date('2026-01-03T00:00:00.000Z'),
        }),
      ].map((row) => inventoryRepo.save(row)),
    );

    const familyKey = 'feeding-deduct-exact-lot-proof';
    const deduction = await runInTenantTransaction(
      dataSource,
      'farm',
      TENANT,
      (_queryRunner, session) =>
        authority.recordFeedDeduction(
          session,
          {
            feedId: FEED,
            quantityKg: 150,
            asOf: new Date('2026-08-01T08:00:00.000Z'),
            siteId: SITE,
            reference: 'FEEDING:exact-lot-proof',
            reason: 'Compile immutable composite FEFO allocation',
            idempotencyKey: familyKey,
            allocationFamilyKey: familyKey,
          },
          { tenantId: TENANT, userId: USER },
        ),
    );
    expect(deduction.movements.map((movement) => movement.lotNumber)).toEqual(['LOT-A', 'LOT-B']);

    const correction = await runInTenantTransaction(
      dataSource,
      'farm',
      TENANT,
      (_queryRunner, session) =>
        authority.recordFeedCorrection(
          session,
          {
            feedId: FEED,
            deltaKg: -150,
            asOf: new Date('2026-08-02T08:00:00.000Z'),
            siteId: SITE,
            sourceDeductionKey: familyKey,
            idempotencyKey: 'feeding-correct-exact-lot-proof',
            reference: 'FEEDING-CORRECTION: exact-lot-proof',
          },
          { tenantId: TENANT, userId: USER },
        ),
    );

    expect(correction.movements.map((movement) => Number(movement.quantity))).toEqual([149.7, 0.3]);
    expect(correction.movements.map((movement) => movement.sourceMovementId)).toEqual([
      deduction.movements[1]?.id,
      deduction.movements[0]?.id,
    ]);
    expect(
      correction.movements.every((movement) => movement.allocationFamilyKey === familyKey),
    ).toBe(true);
    const restored = await inventoryRepo.find({
      where: { tenantId: TENANT, storageLocationId: SOURCE, itemId: FEED },
      order: { lotNumber: 'ASC' },
    });
    expect(
      restored.map((row) => ({
        lotNumber: row.lotNumber,
        quantity: Number(row.quantity),
        receivedDate: row.receivedDate?.toISOString(),
      })),
    ).toEqual([
      { lotNumber: 'LOT-A', quantity: 0.3, receivedDate: receivedA.toISOString() },
      { lotNumber: 'LOT-B', quantity: 149.7, receivedDate: receivedB.toISOString() },
      {
        lotNumber: 'LOT-RESIDENT',
        quantity: 10,
        receivedDate: '2026-01-03T00:00:00.000Z',
      },
    ]);
    expect(await tenantManagerRepo(dataSource.manager, StorageLotMix, TENANT).count()).toBe(0);
  });

  it('treats an omitted transfer lot as the exact NULL-lot key', async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    const inventoryRepo = tenantManagerRepo(dataSource.manager, StorageInventory, TENANT);
    await Promise.all(
      [
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 5,
          unit: 'kg',
        }),
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 100,
          unit: 'kg',
          lotNumber: 'LOT-NOT-SELECTED',
        }),
      ].map((inventory) => inventoryRepo.save(inventory)),
    );

    await expect(
      runInTenantTransaction(dataSource, 'farm', TENANT, (_queryRunner, session) =>
        authority.recordMovement(
          session,
          {
            movementType: MovementType.TRANSFER,
            itemType: StorageItemType.FEED,
            itemId: FEED,
            quantity: 6,
            fromLocationId: SOURCE,
            toLocationId: DESTINATION,
          },
          { tenantId: TENANT, userId: USER },
        ),
      ),
    ).rejects.toThrow('Available: 5');

    await runInTenantTransaction(dataSource, 'farm', TENANT, (_queryRunner, session) =>
      authority.recordMovement(
        session,
        {
          movementType: MovementType.TRANSFER,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 5,
          fromLocationId: SOURCE,
          toLocationId: DESTINATION,
          idempotencyKey: 'transfer-null-lot',
        },
        { tenantId: TENANT, userId: USER },
      ),
    );

    const lotted = await inventoryRepo.findOneOrFail({
      where: {
        tenantId: TENANT,
        storageLocationId: SOURCE,
        lotNumber: 'LOT-NOT-SELECTED',
      },
    });
    const destinationRows = await inventoryRepo.find({
      where: { tenantId: TENANT, storageLocationId: DESTINATION },
    });
    expect(Number(lotted.quantity)).toBe(100);
    expect(destinationRows).toHaveLength(1);
    expect(destinationRows[0]?.lotNumber).toBeNull();
    expect(Number(destinationRows[0]?.quantity)).toBe(5);
  });

  it('serializes concurrent ingress when the physical inventory row does not exist yet', async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    const receive = (quantity: number, idempotencyKey: string) =>
      runInTenantTransaction(dataSource!, 'farm', TENANT, (_queryRunner, session) =>
        authority.recordMovement(
          session,
          {
            movementType: MovementType.IN,
            itemType: StorageItemType.FEED,
            itemId: FEED,
            quantity,
            toLocationId: SOURCE,
            lotNumber: 'LOT-CONCURRENT',
            idempotencyKey,
          },
          { tenantId: TENANT, userId: USER },
        ),
      );

    await Promise.all([receive(2, 'concurrent-receipt-a'), receive(3, 'concurrent-receipt-b')]);

    const rows = await tenantManagerRepo(dataSource.manager, StorageInventory, TENANT).find({
      where: {
        tenantId: TENANT,
        storageLocationId: SOURCE,
        itemType: StorageItemType.FEED,
        itemId: FEED,
        lotNumber: 'LOT-CONCURRENT',
      },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.quantity)).toBe(5);
    expect(await tenantManagerRepo(dataSource.manager, StockMovement, TENANT).count()).toBe(2);
  });

  it('converges concurrent reverse transfers without location-order ABBA waits', async () => {
    if (!dataSource) throw new Error('Stock authority datasource did not start');
    const inventoryRepo = tenantManagerRepo(dataSource.manager, StorageInventory, TENANT);
    await Promise.all(
      [
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: SOURCE,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 10,
          unit: 'kg',
          lotNumber: 'LOT-REVERSE',
          receivedDate: new Date('2026-01-01T00:00:00.000Z'),
        }),
        inventoryRepo.create({
          tenantId: TENANT,
          storageLocationId: DESTINATION,
          itemType: StorageItemType.FEED,
          itemId: FEED,
          quantity: 10,
          unit: 'kg',
          lotNumber: 'LOT-REVERSE',
          receivedDate: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ].map((row) => inventoryRepo.save(row)),
    );
    const transfer = (
      fromLocationId: string,
      toLocationId: string,
      quantity: number,
      idempotencyKey: string,
    ) =>
      runInTenantTransaction(dataSource!, 'farm', TENANT, (_queryRunner, session) =>
        authority.recordMovement(
          session,
          {
            movementType: MovementType.TRANSFER,
            itemType: StorageItemType.FEED,
            itemId: FEED,
            quantity,
            fromLocationId,
            toLocationId,
            lotNumber: 'LOT-REVERSE',
            idempotencyKey,
          },
          { tenantId: TENANT, userId: USER },
        ),
      );

    await Promise.all([
      transfer(SOURCE, DESTINATION, 2, 'reverse-transfer-a'),
      transfer(DESTINATION, SOURCE, 3, 'reverse-transfer-b'),
    ]);

    const rows = await inventoryRepo.find({
      where: { tenantId: TENANT, itemId: FEED, lotNumber: 'LOT-REVERSE' },
      order: { storageLocationId: 'ASC' },
    });
    expect(rows).toHaveLength(2);
    const quantities = new Map(rows.map((row) => [row.storageLocationId, Number(row.quantity)]));
    expect(quantities.get(SOURCE)).toBe(11);
    expect(quantities.get(DESTINATION)).toBe(9);
  });
});
