/**
 * Low-stock tiers that move WITHOUT a stock movement, and tiers under
 * concurrent movements — against a REAL PostgreSQL (plan K8; V-B1-4, V-B1-5
 * and V-B1-8 of the B1a-1 verifier round).
 *
 * ## Why this suite has to hit a real database
 *
 * The edge trigger is only as good as its serialisation. `StockTierWatch` and
 * `StockMovementService` both take the item's transaction-scoped advisory lock
 * and compare the tier bands before and after their change inside one
 * transaction; the claim "exactly one LowStockDetected per crossing" depends
 * on Postgres actually blocking the second writer until the first commits,
 * on the READ COMMITTED snapshot the second writer then sees, and on the outbox
 * row committing with the change. Mocks cannot fail any of that.
 *
 * ## Shape
 *
 * One tenant schema derived from the synchronize-built `farm` source, entered
 * through the real `runInTenantTransaction` boundary; every writer is the REAL
 * command handler or the REAL sink with the REAL outbox publisher, and every
 * assertion reads the durable `LowStockDetected` rows back from
 * `farm.outbox_events` and the projected catalog row.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { stub } from '@aquaculture/testing';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, DeepPartial, ObjectLiteral } from 'typeorm';

import { Chemical } from '../../chemical/entities/chemical.entity';
import { RestoreService } from '../../common/services/restore.service';
import {
  Consumable,
  ConsumableCategory,
  ConsumableStatus,
} from '../../consumable/entities/consumable.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { UpdateFeedCommand } from '../../feed/commands/update-feed.command';
import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { UpdateFeedHandler } from '../../feed/handlers/update-feed.handler';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { RestoreSiteCommand } from '../../site/commands/restore-site.command';
import { Site } from '../../site/entities/site.entity';
import { RestoreSiteHandler } from '../../site/handlers/restore-site.handler';
import { UpdatePurchaseOrderStatusCommand } from '../../storage/commands/update-purchase-order-status.command';
import { UpsertStorageItemSitePolicyCommand } from '../../storage/commands/upsert-storage-item-site-policy.command';
import { PurchaseOrderItem } from '../../storage/entities/purchase-order-item.entity';
import {
  PurchaseOrder,
  PurchaseOrderCategory,
  PurchaseOrderStatus,
} from '../../storage/entities/purchase-order.entity';
import { MovementType, StockMovement } from '../../storage/entities/stock-movement.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StorageItemSitePolicy } from '../../storage/entities/storage-item-site-policy.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import { StorageLotMix } from '../../storage/entities/storage-lot-mix.entity';
import { UpsertStorageItemSitePolicyHandler } from '../../storage/handlers/upsert-storage-item-site-policy.handler';
import { CatalogStockProjector } from '../../storage/services/catalog-stock-projector.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { LowStockEvaluator } from '../../storage/services/low-stock/low-stock-evaluator.service';
import { StockLedgerReader } from '../../storage/services/low-stock/stock-ledger.reader';
import { StockTierWatch } from '../../storage/services/low-stock/stock-tier-watch.service';
import { LotMixService } from '../../storage/services/lot-mix.service';
import {
  RecordMovementInput,
  StockMovementService,
} from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { Supplier } from '../../supplier/entities/supplier.entity';

import { createUpdatePurchaseOrderStatusHandler } from './helpers/storage-handler-fixture';
import { createFarmOutboxTable, createTenantSchemaDerived } from './helpers/tenant-schema-harness';

const TENANT = '7b3e1f2a-9c4d-4e5f-8a6b-1c2d3e4f5a6b';
const USER = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const OTHER_USER = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';

type OutboxPayload = Record<string, unknown>;

/** A promise the test resolves by hand (holds a transaction open). */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('Low-stock tiers without movements and under concurrency — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let seq = 0;

  const locks = new StockMutationLockAuthority();
  const projector = new CatalogStockProjector(new StockLedgerReader());
  const outbox = new OutboxPublisher(FarmOutbox);
  const tierWatch = new StockTierWatch(
    new LowStockEvaluator(new StockLedgerReader()),
    locks,
    projector,
    outbox,
  );
  const stockMovements = new StockMovementService(
    new LotMixService(),
    new SiteAuthorizationService(),
    outbox,
    locks,
    new FeedAllocationService(locks),
    new LowStockEvaluator(new StockLedgerReader()),
    projector,
  );

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-tier-watch-${randomBytes(4).toString('hex')}`,
      entities: [
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
        SparePart,
        Supplier,
        EquipmentType,
        Site,
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

  // ── seed + probe helpers (every write lands in TENANT's schema) ──────────

  function insert<E extends ObjectLiteral>(entity: new () => E, row: DeepPartial<E>): Promise<E> {
    return withTenantContext(TENANT, () => {
      const manager = dataSource.manager;
      return manager.save(manager.create(entity, row));
    });
  }

  async function site(isDeleted = false): Promise<string> {
    seq += 1;
    const row = await insert(Site, {
      tenantId: TENANT,
      name: `Site ${seq}`,
      code: `SITE-${seq}`,
      isDeleted,
      isActive: !isDeleted,
    });
    return row.id;
  }

  async function location(siteId: string): Promise<string> {
    seq += 1;
    const row = await insert(StorageLocation, {
      tenantId: TENANT,
      siteId,
      code: `LOC-${seq}`,
      name: `Store ${seq}`,
      usedCapacity: 0,
    });
    return row.id;
  }

  async function feed(minStock: number): Promise<string> {
    seq += 1;
    const row = await insert(Feed, {
      tenantId: TENANT,
      name: `Grower ${seq}`,
      code: `FEED-${seq}`,
      type: FeedType.GROWER,
      floatingType: FloatingType.FLOATING,
      status: FeedStatus.AVAILABLE,
      quantity: 0,
      minStock,
      unit: 'kg',
      isActive: true,
      isDeleted: false,
    });
    return row.id;
  }

  async function lot(
    locationId: string,
    itemId: string,
    quantity: number,
    itemType: StorageItemType = StorageItemType.FEED,
  ): Promise<void> {
    await insert(StorageInventory, {
      tenantId: TENANT,
      storageLocationId: locationId,
      itemType,
      itemId,
      quantity,
      unit: 'kg',
    });
  }

  function move(input: RecordMovementInput): Promise<unknown> {
    return runInTenantTransaction(dataSource, 'farm', TENANT, (queryRunner) =>
      stockMovements.recordMovement(queryRunner.manager, input, { tenantId: TENANT, userId: USER }),
    );
  }

  async function events(itemId: string): Promise<OutboxPayload[]> {
    const rows: Array<{ payload: OutboxPayload }> = await dataSource.query(
      `SELECT "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1 AND "eventType" = 'LowStockDetected'
          AND "payload"->>'itemId' = $2
        ORDER BY "id" ASC`,
      [TENANT, itemId],
    );
    return rows.map((row) => row.payload);
  }

  async function feedStatus(itemId: string): Promise<FeedStatus> {
    const rows: Array<{ status: FeedStatus }> = await dataSource.query(
      `SELECT "status" FROM "${getTenantSchemaName(TENANT)}"."feeds" WHERE "id" = $1`,
      [itemId],
    );
    const [row] = rows;
    if (!row) throw new Error(`feed ${itemId} is missing from the tenant schema`);
    return row.status;
  }

  function upsertPolicy(siteId: string, itemId: string, minStock: number): Promise<{ id: string }> {
    return new UpsertStorageItemSitePolicyHandler(dataSource, tierWatch).execute(
      new UpsertStorageItemSitePolicyCommand(
        { siteId, itemType: StorageItemType.FEED, itemId, minStock },
        TENANT,
        USER,
      ),
    );
  }

  // ── V-B1-5: tiers moved by a command, not by stock ───────────────────────

  describe('commands that move a tier without moving stock (StockTierWatch)', () => {
    it('signals a raised site minimum once, and nothing while the site stays low', async () => {
      // SCENARIO: 120 kg at site A. Policy 100 (ok), raised to 150 (low), raised
      // again to 200 (still low), then an OUT of 10 (still low).
      // EXPECTS: exactly one site low_stock event, caused by the policy row.
      const siteA = await site();
      const locA = await location(siteA);
      const item = await feed(0);
      await lot(locA, item, 120);

      await upsertPolicy(siteA, item, 100);
      expect(await events(item)).toEqual([]);
      const raised = await upsertPolicy(siteA, item, 150);
      await upsertPolicy(siteA, item, 200);
      await move({
        movementType: MovementType.OUT,
        itemType: StorageItemType.FEED,
        itemId: item,
        quantity: 10,
        fromLocationId: locA,
      });

      expect(await events(item)).toEqual([
        expect.objectContaining({
          level: 'site',
          siteId: siteA,
          severity: 'low_stock',
          currentQuantity: 120,
          minimumThreshold: 150,
          causationId: raised.id,
        }),
      ]);
    });

    it('signals out_of_stock for a new minimum at a site that holds nothing', async () => {
      // SCENARIO: the item lies only at site A; a manager sets a minimum at site B.
      // EXPECTS: one site B out_of_stock event (the tier did not exist before).
      const siteA = await site();
      const siteB = await site();
      const item = await feed(0);
      await lot(await location(siteA), item, 40);

      await upsertPolicy(siteB, item, 25);

      expect(await events(item)).toEqual([
        expect.objectContaining({ level: 'site', siteId: siteB, severity: 'out_of_stock' }),
      ]);
    });

    it('signals the pool and re-projects LOW when the order that covered it is cancelled (V-B1-4)', async () => {
      // SCENARIO: minStock 100, 80 on hand, an ORDERED line with 50 still to come
      // (position 130: covered, catalog AVAILABLE). The order is cancelled.
      // EXPECTS: one pool low_stock event caused by the order; feeds.status LOW_STOCK.
      const item = await feed(100);
      await lot(await location(await site()), item, 80);
      const order = await insert(PurchaseOrder, {
        tenantId: TENANT,
        orderNumber: `PO-${randomUUID().slice(0, 8)}`,
        category: PurchaseOrderCategory.FEED,
        supplierName: 'Nordic Supply AS',
        status: PurchaseOrderStatus.ORDERED,
        isDeleted: false,
        createdBy: USER,
      });
      await insert(PurchaseOrderItem, {
        tenantId: TENANT,
        purchaseOrderId: order.id,
        itemId: item,
        itemName: 'Grower',
        quantity: 70,
        unit: 'kg',
        quantityReceived: 20,
      });
      await runInTenantTransaction(dataSource, 'farm', TENANT, (queryRunner) =>
        projector.project(queryRunner.manager, TENANT, StorageItemType.FEED, item),
      );
      expect(await feedStatus(item)).toBe(FeedStatus.AVAILABLE);

      await withTenantContext(TENANT, () =>
        createUpdatePurchaseOrderStatusHandler(dataSource, tierWatch).execute(
          new UpdatePurchaseOrderStatusCommand(
            { id: order.id, status: PurchaseOrderStatus.CANCELLED },
            TENANT,
            USER,
          ),
        ),
      );

      expect(await events(item)).toEqual([
        expect.objectContaining({
          level: 'pool',
          severity: 'low_stock',
          currentQuantity: 80,
          onOrderQuantity: 0,
          minimumThreshold: 100,
          causationId: order.id,
        }),
      ]);
      expect(await feedStatus(item)).toBe(FeedStatus.LOW_STOCK);
    });

    it('signals a raised catalog minStock through the feed update', async () => {
      // SCENARIO: 80 kg on hand, minStock 50 → 100 via updateFeed.
      // EXPECTS: one pool low_stock event caused by the feed; status LOW_STOCK.
      const item = await feed(50);
      await lot(await location(await site()), item, 80);

      await new UpdateFeedHandler(dataSource, tierWatch).execute(
        new UpdateFeedCommand(item, { id: item, minStock: 100 }, TENANT, USER),
      );

      expect(await events(item)).toEqual([
        expect.objectContaining({
          level: 'pool',
          severity: 'low_stock',
          minimumThreshold: 100,
          causationId: item,
        }),
      ]);
      expect(await feedStatus(item)).toBe(FeedStatus.LOW_STOCK);
    });

    it('signals the dormant policy a site restore wakes', async () => {
      // SCENARIO: a deleted site keeps its 50 kg policy (dormant) and 20 kg of
      // stock; a tenant admin restores the site. EXPECTS: one site low_stock
      // event caused by the site — nothing was emitted while it was deleted.
      const closed = await site(true);
      const item = await feed(0);
      await lot(await location(closed), item, 20);
      await insert(StorageItemSitePolicy, {
        tenantId: TENANT,
        siteId: closed,
        itemType: StorageItemType.FEED,
        itemId: item,
        minStock: 50,
        createdBy: USER,
        updatedBy: USER,
      });
      const restore = new RestoreService(
        stub<AuditLogService>({ logRestore: jest.fn().mockResolvedValue(undefined) }),
      );

      await new RestoreSiteHandler(dataSource, restore, tierWatch).execute(
        new RestoreSiteCommand(closed, TENANT, OTHER_USER),
      );

      expect(await events(item)).toEqual([
        expect.objectContaining({
          level: 'site',
          siteId: closed,
          severity: 'low_stock',
          currentQuantity: 20,
          causationId: closed,
        }),
      ]);
    });
  });

  // ── V-B1-8: two truly concurrent writers crossing one threshold ───────────

  /**
   * Which lock makes each case hold (falsified by removing them on this suite):
   * the feed and consumable cases stay exact even with the item lock AND the
   * projector's row lock removed, because every movement also UPDATEs its
   * catalog projection row, and the second writer's crossing read runs after
   * that row write waited for the first commit. Spare parts have no projection
   * row, so the spare-part case holds ONLY through the item's stock mutation
   * lock — and fails without it (two events, the second writer never blocks).
   */
  describe('concurrent movements crossing one threshold', () => {
    /**
     * Run `first` inside a transaction held open until `second` has started
     * and is blocked; returns whether `second` finished before `first` let go.
     */
    async function overlap(
      first: RecordMovementInput,
      second: RecordMovementInput,
    ): Promise<{ secondFinishedEarly: boolean }> {
      const firstMoved = gate();
      const release = gate();
      let secondDone = false;
      const firstTx = runInTenantTransaction(dataSource, 'farm', TENANT, async (queryRunner) => {
        await stockMovements.recordMovement(queryRunner.manager, first, {
          tenantId: TENANT,
          userId: USER,
        });
        firstMoved.open();
        // Hold the lock (and the uncommitted movement) until the test releases.
        await release.promise;
      });
      await firstMoved.promise;
      const secondTx = move(second).then(() => {
        secondDone = true;
      });
      // Give the second writer time to reach the advisory lock and block on it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const secondFinishedEarly = secondDone;
      release.open();
      await firstTx;
      await secondTx;
      return { secondFinishedEarly };
    }

    it('emits exactly one pool event when two OUTs cross the reorder threshold together', async () => {
      // SCENARIO: 120 kg (reorder 100) in two stores of one site (60 + 60), so
      // the two concurrent OUTs of 30 share no inventory row. EXPECTS: the second
      // waits for the first; 60 kg remain; exactly one pool low_stock event (the
      // first crossing), none for the second.
      const item = await feed(100);
      const siteId = await site();
      const storeA = await location(siteId);
      const storeB = await location(siteId);
      await lot(storeA, item, 60);
      await lot(storeB, item, 60);
      const out = (fromLocationId: string): RecordMovementInput => ({
        movementType: MovementType.OUT,
        itemType: StorageItemType.FEED,
        itemId: item,
        quantity: 30,
        fromLocationId,
      });

      const { secondFinishedEarly } = await overlap(out(storeA), out(storeB));

      expect(secondFinishedEarly).toBe(false);
      const pool = (await events(item)).filter((event) => event.level === 'pool');
      expect(pool).toEqual([
        expect.objectContaining({ severity: 'low_stock', currentQuantity: 90 }),
      ]);
      const remaining: Array<{ total: string }> = await dataSource.query(
        `SELECT COALESCE(SUM("quantity"), 0)::text AS total
           FROM "${getTenantSchemaName(TENANT)}"."storage_inventory" WHERE "item_id" = $1`,
        [item],
      );
      expect(remaining.map((row) => Number(row.total))).toEqual([60]);
    });

    it('emits exactly one pool event for two concurrent spare-part OUTs at different stores', async () => {
      // SCENARIO: a spare part (reorder point 100) holds 60 in each of two stores
      // of one site; two OUTs of 30 run concurrently. Spare parts have no catalog
      // projection row to lock, so ONLY the item's stock mutation lock stands
      // between the two crossing checks. EXPECTS: the second waits; exactly one
      // pool low_stock event.
      seq += 1;
      const part = await insert(SparePart, {
        tenantId: TENANT,
        code: `SP-${String(seq).padStart(6, '0')}`,
        name: `Impeller ${seq}`,
        partNumber: `PN-${seq}`,
        isActive: true,
        reorderPoint: 100,
        minStock: 0,
        maxStock: 0,
        unit: 'piece',
      });
      const siteId = await site();
      const storeA = await location(siteId);
      const storeB = await location(siteId);
      await lot(storeA, part.id, 60, StorageItemType.SPARE_PART);
      await lot(storeB, part.id, 60, StorageItemType.SPARE_PART);
      const out = (fromLocationId: string): RecordMovementInput => ({
        movementType: MovementType.OUT,
        itemType: StorageItemType.SPARE_PART,
        itemId: part.id,
        quantity: 30,
        fromLocationId,
      });

      const { secondFinishedEarly } = await overlap(out(storeA), out(storeB));

      expect(secondFinishedEarly).toBe(false);
      expect((await events(part.id)).filter((event) => event.level === 'pool')).toEqual([
        expect.objectContaining({ severity: 'low_stock', currentQuantity: 90 }),
      ]);
    });

    it('treats HEALTHCARE and CONSUMABLE bookings of one consumable as one item under concurrency', async () => {
      // SCENARIO: one consumable (minStock 100) holds 60 booked as CONSUMABLE and
      // 60 booked as HEALTHCARE at one site; an OUT of 30 from each booking runs
      // concurrently. EXPECTS: they serialise on ONE canonical lock, and exactly
      // one pool low_stock event is emitted for the item.
      seq += 1;
      const consumable = await insert(Consumable, {
        tenantId: TENANT,
        name: `Vaccine ${seq}`,
        code: `CONS-${seq}`,
        category: ConsumableCategory.OTHER,
        status: ConsumableStatus.AVAILABLE,
        unit: 'kg',
        quantity: 0,
        minStock: 100,
        isActive: true,
        isDeleted: false,
      });
      const loc = await location(await site());
      await lot(loc, consumable.id, 60, StorageItemType.CONSUMABLE);
      await lot(loc, consumable.id, 60, StorageItemType.HEALTHCARE);
      const out = (itemType: StorageItemType): RecordMovementInput => ({
        movementType: MovementType.OUT,
        itemType,
        itemId: consumable.id,
        quantity: 30,
        fromLocationId: loc,
      });

      const { secondFinishedEarly } = await overlap(
        out(StorageItemType.CONSUMABLE),
        out(StorageItemType.HEALTHCARE),
      );

      expect(secondFinishedEarly).toBe(false);
      expect((await events(consumable.id)).filter((event) => event.level === 'pool')).toEqual([
        expect.objectContaining({
          itemType: StorageItemType.CONSUMABLE,
          severity: 'low_stock',
          currentQuantity: 90,
        }),
      ]);
    });
  });
});
