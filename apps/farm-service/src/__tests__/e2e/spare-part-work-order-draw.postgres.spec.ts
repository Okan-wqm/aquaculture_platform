/**
 * Work-order spare-part consumption across the work order's site — REAL
 * PostgreSQL (FARM-HIGH-338, V-B1-9 of the B1a-1 verifier round).
 *
 * ## Why this suite has to hit a real database
 *
 * The draw is planned from rows the ledger service reads (live locations of
 * the site, positive rows of the part) and executed as OUT movements through
 * the REAL sink, whose unpinned decrement must land on the row each slice was
 * planned for. The site of the work order comes from its asset's department.
 * Only Postgres can prove the plan and the sink agree, that another site's
 * store is never touched, and that a short site rolls the whole completion
 * back.
 *
 * ## Shape
 *
 * One tenant schema derived from the synchronize-built `farm` source; the
 * consumption runs inside `runInTenantTransaction` like work-order completion.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, DeepPartial, ObjectLiteral } from 'typeorm';

import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../department/entities/department.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import { AssetType } from '../../maintenance/entities/work-order.entity';
import { SparePartLedgerService } from '../../maintenance/services/spare-part-ledger.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { Site } from '../../site/entities/site.entity';
import { Species } from '../../species/entities/species.entity';
import { PurchaseOrderItem } from '../../storage/entities/purchase-order-item.entity';
import { PurchaseOrder } from '../../storage/entities/purchase-order.entity';
import { StockMovement } from '../../storage/entities/stock-movement.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StorageItemSitePolicy } from '../../storage/entities/storage-item-site-policy.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import { StorageLotMix } from '../../storage/entities/storage-lot-mix.entity';
import { CatalogStockProjector } from '../../storage/services/catalog-stock-projector.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { LowStockEvaluator } from '../../storage/services/low-stock/low-stock-evaluator.service';
import { StockLedgerReader } from '../../storage/services/low-stock/stock-ledger.reader';
import { LotMixService } from '../../storage/services/lot-mix.service';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { SubSystem } from '../../system/entities/sub-system.entity';
import { System } from '../../system/entities/system.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';

import { createFarmOutboxTable, createTenantSchemaDerived } from './helpers/tenant-schema-harness';

const TENANT = '2c4e6a8b-1d3f-4a5b-9c7d-8e0f1a2b3c4d';
const USER = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

describe('Work-order spare-part draw across the site — real Postgres (V-B1-9)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let seq = 0;

  const locks = new StockMutationLockAuthority();
  const ledger = new SparePartLedgerService(
    new StockMovementService(
      new LotMixService(),
      new SiteAuthorizationService(),
      new OutboxPublisher(FarmOutbox),
      locks,
      new FeedAllocationService(locks),
      new LowStockEvaluator(new StockLedgerReader()),
      new CatalogStockProjector(new StockLedgerReader()),
    ),
    locks,
  );

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-wo-draw-${randomBytes(4).toString('hex')}`,
      entities: [
        SparePart,
        Supplier,
        EquipmentType,
        Equipment,
        EquipmentSystem,
        Site,
        Department,
        System,
        SubSystem,
        Tank,
        TankBatch,
        Batch,
        BatchDocument,
        Species,
        StorageLocation,
        StorageInventory,
        StockMovement,
        StorageLotMix,
        StorageItemSitePolicy,
        PurchaseOrder,
        PurchaseOrderItem,
        Feed,
        Chemical,
        Consumable,
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  function insert<E extends ObjectLiteral>(entity: new () => E, row: DeepPartial<E>): Promise<E> {
    return withTenantContext(TENANT, () => {
      const manager = dataSource.manager;
      return manager.save(manager.create(entity, row));
    });
  }

  function next(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  async function site(): Promise<string> {
    return (await insert(Site, { tenantId: TENANT, name: next('Site'), code: next('S') })).id;
  }

  async function store(siteId: string): Promise<string> {
    return (
      await insert(StorageLocation, {
        tenantId: TENANT,
        siteId,
        code: next('LOC'),
        name: next('Store'),
        usedCapacity: 0,
      })
    ).id;
  }

  /** A tank in a department of `siteId` — the work order's asset. */
  async function tankAt(siteId: string): Promise<string> {
    const department = await insert(Department, {
      tenantId: TENANT,
      siteId,
      name: next('Dept'),
      code: next('D'),
      type: DepartmentType.PRODUCTION,
      status: DepartmentStatus.ACTIVE,
      isActive: true,
      isDeleted: false,
    });
    const tank = await insert(Tank, {
      tenantId: TENANT,
      name: next('Tank'),
      code: next('TNK'),
      departmentId: department.id,
      tankType: TankType.CIRCULAR,
      material: TankMaterial.FIBERGLASS,
      waterType: WaterType.SALTWATER,
      diameter: 5,
      depth: 2,
      waterDepth: 2,
      maxBiomass: 1500,
      currentBiomass: 0,
      currentCount: 0,
      maxDensity: 30,
      status: TankStatus.ACTIVE,
      isActive: true,
    });
    return tank.id;
  }

  async function part(homeLocationId: string): Promise<string> {
    return (
      await insert(SparePart, {
        tenantId: TENANT,
        code: next('SP'),
        name: next('Seal kit'),
        partNumber: next('PN'),
        isActive: true,
        reorderPoint: 0,
        minStock: 0,
        maxStock: 0,
        unit: 'piece',
        storageLocationId: homeLocationId,
      })
    ).id;
  }

  async function lot(
    locationId: string,
    itemId: string,
    quantity: number,
    receivedDate: string,
  ): Promise<void> {
    await insert(StorageInventory, {
      tenantId: TENANT,
      storageLocationId: locationId,
      itemType: StorageItemType.SPARE_PART,
      itemId,
      quantity,
      unit: 'piece',
      receivedDate: new Date(receivedDate),
    });
  }

  async function onHandAt(itemId: string): Promise<Record<string, number>> {
    const rows: Array<{ location: string; total: string }> = await dataSource.query(
      `SELECT "storage_location_id"::text AS location, SUM("quantity")::text AS total
         FROM "${getTenantSchemaName(TENANT)}"."storage_inventory"
        WHERE "item_id" = $1 GROUP BY "storage_location_id"`,
      [itemId],
    );
    return Object.fromEntries(rows.map((row) => [row.location, Number(row.total)]));
  }

  function consume(
    workOrder: { id: string; assetType?: AssetType; assetId?: string },
    sparePartId: string,
    quantity: number,
  ): Promise<void> {
    return runInTenantTransaction(dataSource, 'farm', TENANT, (queryRunner) =>
      ledger.consumeForWorkOrder(
        queryRunner.manager,
        TENANT,
        workOrder,
        [{ sparePartId, quantity }],
        USER,
      ),
    );
  }

  it("draws home first, then the site's oldest stock, and never another site's", async () => {
    // SCENARIO: the WO's tank is at site A. The part is homed at A1 (2 pcs); A2
    // holds 5 received in January, A3 5 received in March; B1 at site B 100.
    // EXPECTS: using 8 empties A1 and A2 and takes 1 from A3; B1 untouched.
    const siteA = await site();
    const siteB = await site();
    const [a1, a2, a3, b1] = [
      await store(siteA),
      await store(siteA),
      await store(siteA),
      await store(siteB),
    ];
    const tank = await tankAt(siteA);
    const item = await part(a1);
    await lot(a1, item, 2, '2026-06-01');
    await lot(a2, item, 5, '2026-01-01');
    await lot(a3, item, 5, '2026-03-01');
    await lot(b1, item, 100, '2025-01-01');

    await consume({ id: next('WO'), assetType: AssetType.TANK, assetId: tank }, item, 8);

    // The remaining stock proves the order: A1 and A2 drained, A3 cut to 4 —
    // drawing A3 before A2 would have left A2 holding stock.
    expect(await onHandAt(item)).toEqual({ [a3]: 4, [b1]: 100 });
    // One OUT movement per slice. The rows share one transaction timestamp, so
    // they are compared as a set, not in insertion order.
    const movements: Array<{ from: string; quantity: string }> = await dataSource.query(
      `SELECT "from_location_id"::text AS from, "quantity"::text AS quantity
         FROM "${getTenantSchemaName(TENANT)}"."stock_movements"
        WHERE "item_id" = $1`,
      [item],
    );
    const bySlice = (rows: Array<[string, number]>): Array<[string, number]> =>
      [...rows].sort(([a], [b]) => a.localeCompare(b));
    expect(bySlice(movements.map((row) => [row.from, Number(row.quantity)]))).toEqual(
      bySlice([
        [a1, 2],
        [a2, 5],
        [a3, 1],
      ]),
    );
  });

  it("fails only when the work order's site is short, and moves nothing", async () => {
    // SCENARIO: site A holds 3 (home 1 + another store 2); site B holds 50; the WO
    // at site A uses 4. EXPECTS: 400 naming site A's 3, every row unchanged.
    const siteA = await site();
    const siteB = await site();
    const [a1, a2, b1] = [await store(siteA), await store(siteA), await store(siteB)];
    const tank = await tankAt(siteA);
    const item = await part(a1);
    await lot(a1, item, 1, '2026-01-01');
    await lot(a2, item, 2, '2026-01-02');
    await lot(b1, item, 50, '2026-01-03');

    await expect(
      consume({ id: next('WO'), assetType: AssetType.TANK, assetId: tank }, item, 4),
    ).rejects.toThrow('Available: 3, requested: 4');
    expect(await onHandAt(item)).toEqual({ [a1]: 1, [a2]: 2, [b1]: 50 });
  });

  it('draws at the home site for an asset the farm model does not place', async () => {
    // SCENARIO: a vehicle work order (no site in the farm model); the part is homed
    // at site A (A1 1, A2 3) and site B holds 10. EXPECTS: A1 then A2; B untouched.
    const siteA = await site();
    const siteB = await site();
    const [a1, a2, b1] = [await store(siteA), await store(siteA), await store(siteB)];
    const item = await part(a1);
    await lot(a1, item, 1, '2026-02-01');
    await lot(a2, item, 3, '2026-01-01');
    await lot(b1, item, 10, '2025-01-01');

    await consume({ id: next('WO'), assetType: AssetType.VEHICLE, assetId: a1 }, item, 3);

    expect(await onHandAt(item)).toEqual({ [a2]: 1, [b1]: 10 });
  });
});
