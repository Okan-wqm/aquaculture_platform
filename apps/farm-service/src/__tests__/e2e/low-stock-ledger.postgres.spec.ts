/**
 * The two-tier low-stock ledger against a REAL PostgreSQL (plan K8,
 * FARM-HIGH-335 / FARM-HIGH-336).
 *
 * ## Why this suite has to hit a real database
 *
 * Every low-stock decision is a SUM over `storage_inventory`, grouped through
 * `storage_locations.site_id`, plus the unreceived remainder of open purchase
 * orders. The unit suite (`low-stock-evaluator.service.spec.ts`) hands the
 * evaluator pre-folded rows, so none of the things that decide the numbers can
 * fail there: the snake_case columns behind camelCase properties, the tenant
 * predicate the scoped repository injects, the soft-delete filter on
 * locations, the purchase-order status and category filters, the DECIMAL
 * round-trip. That is the class FARM-CRITICAL-242 / FARM-HIGH-300 shipped
 * green — only Postgres sees it.
 *
 * ## Shape
 *
 * Every case builds its OWN tenant (own locations, own items), so a tenant-wide
 * read such as `listBelowThreshold` sees exactly the rows its case seeded.
 * Other-tenant rows are written into the SAME schema on purpose: there is no
 * schema boundary here, so only the tenant predicate can exclude them.
 *
 * The two tables whose production DDL carries rules an entity cannot express
 * are built from their migrations, not from `synchronize`:
 * `storage_item_site_policies` (1811100000000: CHECK min_stock > 0 + unique
 * site/item) and the `storage_inventory` canonical key (1809700000000).
 *
 * The sink case drives the REAL `StockMovementService` with a REAL
 * `OutboxPublisher`, wired the way
 * `feeding-record-tenant-isolation.postgres.spec.ts` wires it, and reads the
 * durable `LowStockDetected` rows back from `farm.outbox_events`.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { Chemical, ChemicalStatus, ChemicalType } from '../../chemical/entities/chemical.entity';
import {
  Consumable,
  ConsumableCategory,
  ConsumableStatus,
} from '../../consumable/entities/consumable.entity';
import { RestoreStorageInventoryCanonicalKey1809700000000 } from '../../database/migrations/1809700000000-RestoreStorageInventoryCanonicalKey';
import { CreateStorageItemSitePolicies1811100000000 } from '../../database/migrations/1811100000000-CreateStorageItemSitePolicies';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import { Site } from '../../site/entities/site.entity';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
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
import { CatalogStockProjector } from '../../storage/services/catalog-stock-projector.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { LowStockEvaluator } from '../../storage/services/low-stock/low-stock-evaluator.service';
import {
  SiteOnHandRow,
  StockLedgerReader,
} from '../../storage/services/low-stock/stock-ledger.reader';
import { LotMixService } from '../../storage/services/lot-mix.service';
import {
  RecordMovementInput,
  RecordMovementResult,
  StockMovementService,
} from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { Supplier } from '../../supplier/entities/supplier.entity';

import { createFarmOutboxTable } from './helpers/tenant-schema-harness';

const USER = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

const FEED = StorageItemType.FEED;

/**
 * One tenant's layout: live sites A, B and C (C holds no location), two live
 * locations at A, one at B, one closed at A.
 */
interface World {
  tenantId: string;
  siteA: string;
  siteB: string;
  siteC: string;
  locA1: string;
  locA2: string;
  locB1: string;
  locClosedA: string;
}

/**
 * A fresh site id whose first segment sorts A < B < C, so per-site results
 * compare in a stable order while every world owns distinct `sites` rows.
 */
function siteIdSorting(letter: 'a' | 'b' | 'c'): string {
  const hex = randomBytes(6).toString('hex');
  return `${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${hex}`;
}

interface LotSeed {
  locationId: string;
  itemId: string;
  quantity: number;
  itemType?: StorageItemType;
  lotNumber?: string;
  /** Written under another tenant — only the tenant predicate may exclude it. */
  tenantId?: string;
}

interface OrderLineSeed {
  itemId: string;
  quantity: number;
  quantityReceived?: number;
}

interface OrderSeed {
  category: PurchaseOrderCategory;
  status: PurchaseOrderStatus;
  lines: OrderLineSeed[];
  isDeleted?: boolean;
}

type OutboxPayload = Record<string, unknown>;

describe('Two-tier low-stock ledger — real Postgres (plan K8)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let orderSeq = 0;

  const reader = new StockLedgerReader();
  const evaluator = new LowStockEvaluator(reader);
  const mutationLocks = new StockMutationLockAuthority();
  // REAL sink, wired exactly as feeding-record-tenant-isolation.postgres.spec.ts
  // wires it: the edge trigger and the outbox write are what is under test.
  const stockMovements = new StockMovementService(
    new LotMixService(),
    new SiteAuthorizationService(),
    new OutboxPublisher(FarmOutbox),
    mutationLocks,
    new FeedAllocationService(mutationLocks),
    new LowStockEvaluator(new StockLedgerReader()),
    new CatalogStockProjector(new StockLedgerReader()),
  );

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-low-stock-ledger-${randomBytes(4).toString('hex')}`,
      entities: [
        StorageLocation,
        StorageInventory,
        StockMovement,
        StorageLotMix,
        StorageItemSitePolicy,
        PurchaseOrder,
        PurchaseOrderItem,
        // The four catalog tables `StockLedgerReader.catalog` and
        // `describeStorageItem` read, plus their relation closure: TypeORM
        // builds metadata only when every relation TARGET is registered.
        Feed,
        Chemical,
        Consumable,
        SparePart,
        Supplier,
        EquipmentType,
        // `StockLedgerReader.sitePolicies` reads which policy sites are live.
        Site,
        // Metadata for the sink's outbox write; the table itself is created
        // below because the entity is `synchronize: false`.
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await applyProductionDdl();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  /**
   * Replace what `synchronize` cannot express with the production migrations:
   * the site-policy table (CHECK + unique key) and the storage_inventory
   * canonical key. Run in one transaction, the way the migration runner does.
   */
  async function applyProductionDdl(): Promise<void> {
    await dataSource.query('DROP TABLE "farm"."storage_item_site_policies"');
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await new CreateStorageItemSitePolicies1811100000000().up(queryRunner);
      await new RestoreStorageInventoryCanonicalKey1809700000000().up(queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ── seed helpers ──────────────────────────────────────────────────────────

  async function seedWorld(): Promise<World> {
    const world: World = {
      tenantId: randomUUID(),
      siteA: siteIdSorting('a'),
      siteB: siteIdSorting('b'),
      siteC: siteIdSorting('c'),
      locA1: randomUUID(),
      locA2: randomUUID(),
      locB1: randomUUID(),
      locClosedA: randomUUID(),
    };
    await dataSource.manager.save(
      Site,
      [world.siteA, world.siteB, world.siteC].map((id, index) => ({
        id,
        tenantId: world.tenantId,
        name: `Site ${'ABC'[index]}`,
        code: `SITE-${'ABC'[index]}`,
      })),
    );
    // `usedCapacity` is named explicitly, as CreateStorageLocationHandler does.
    await dataSource.manager.save(StorageLocation, [
      {
        id: world.locA1,
        tenantId: world.tenantId,
        siteId: world.siteA,
        code: 'A1',
        name: 'Site A store 1',
        usedCapacity: 0,
      },
      {
        id: world.locA2,
        tenantId: world.tenantId,
        siteId: world.siteA,
        code: 'A2',
        name: 'Site A store 2',
        usedCapacity: 0,
      },
      {
        id: world.locB1,
        tenantId: world.tenantId,
        siteId: world.siteB,
        code: 'B1',
        name: 'Site B store',
        usedCapacity: 0,
      },
      {
        id: world.locClosedA,
        tenantId: world.tenantId,
        siteId: world.siteA,
        code: 'A-CLOSED',
        name: 'Closed store',
        usedCapacity: 0,
        isDeleted: true,
      },
    ]);
    return world;
  }

  async function seedStock(tenantId: string, lots: LotSeed[]): Promise<void> {
    await dataSource.manager.save(
      StorageInventory,
      lots.map((lot) => ({
        tenantId: lot.tenantId ?? tenantId,
        storageLocationId: lot.locationId,
        itemType: lot.itemType ?? FEED,
        itemId: lot.itemId,
        quantity: lot.quantity,
        unit: 'kg',
        lotNumber: lot.lotNumber,
      })),
    );
  }

  async function seedOrder(tenantId: string, order: OrderSeed): Promise<void> {
    orderSeq += 1;
    const saved = await dataSource.manager.save(PurchaseOrder, {
      tenantId,
      orderNumber: `PO-${orderSeq}`,
      category: order.category,
      supplierName: 'Nordic Supply AS',
      status: order.status,
      isDeleted: order.isDeleted ?? false,
      createdBy: USER,
    });
    await dataSource.manager.save(
      PurchaseOrderItem,
      order.lines.map((line) => ({
        tenantId,
        purchaseOrderId: saved.id,
        itemId: line.itemId,
        itemName: 'Ordered item',
        quantity: line.quantity,
        unit: 'kg',
        quantityReceived: line.quantityReceived ?? 0,
      })),
    );
  }

  async function seedPolicy(
    tenantId: string,
    siteId: string,
    itemId: string,
    minStock: number,
    itemType: StorageItemType = FEED,
  ): Promise<void> {
    await dataSource.manager.save(StorageItemSitePolicy, {
      tenantId,
      siteId,
      itemType,
      itemId,
      minStock,
      createdBy: USER,
      updatedBy: USER,
    });
  }

  async function seedFeed(
    tenantId: string,
    itemId: string,
    name: string,
    minStock: number,
    extra: { isDeleted?: boolean } = {},
  ): Promise<void> {
    await dataSource.manager.save(Feed, {
      id: itemId,
      tenantId,
      name,
      code: `FEED-${itemId.slice(0, 8)}`,
      type: FeedType.GROWER,
      floatingType: FloatingType.FLOATING,
      status: FeedStatus.AVAILABLE,
      quantity: 0,
      minStock,
      unit: 'kg',
      isActive: true,
      isDeleted: extra.isDeleted ?? false,
    });
  }

  function inTx<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return dataSource.transaction(work);
  }

  function move(tenantId: string, input: RecordMovementInput): Promise<RecordMovementResult> {
    return dataSource.transaction((manager) =>
      stockMovements.recordMovement(manager, input, { tenantId, userId: USER }),
    );
  }

  async function lowStockEvents(tenantId: string, itemId: string): Promise<OutboxPayload[]> {
    const rows: Array<{ payload: OutboxPayload }> = await dataSource.query(
      `SELECT "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1
          AND "eventType" = 'LowStockDetected'
          AND "payload"->>'itemId' = $2
        ORDER BY "id" ASC`,
      [tenantId, itemId],
    );
    return rows.map((row) => row.payload);
  }

  function sorted(rows: SiteOnHandRow[]): SiteOnHandRow[] {
    const key = (row: SiteOnHandRow): string => `${row.itemType}:${row.itemId}:${row.siteId}`;
    return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  }

  function bySite<R extends { siteId: string }>(rows: R[]): R[] {
    return [...rows].sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  // ── 1. on-hand per site ───────────────────────────────────────────────────

  describe('StockLedgerReader.onHandBySite', () => {
    it('sums every lot of every live location per site, and nothing else', async () => {
      // SCENARIO: site A holds the feed in two locations (A1 with two lots,
      // A2 un-lotted) plus a CLOSED location; site B holds it once. The same
      // item id is also booked as a chemical, a second feed sits in A1, and a
      // foreign tenant has rows in this schema — one of them even pointing at
      // this tenant's own A1 location.
      // EXPECTS: A = 30 + 20 + 15, B = 40; the closed location, the chemical,
      // the other feed and both foreign rows contribute nothing.
      const world = await seedWorld();
      const foreign = await seedWorld();
      const feed = randomUUID();
      const otherFeed = randomUUID();
      await seedStock(world.tenantId, [
        { locationId: world.locA1, itemId: feed, quantity: 30, lotNumber: 'LOT-1' },
        { locationId: world.locA1, itemId: feed, quantity: 20, lotNumber: 'LOT-2' },
        { locationId: world.locA2, itemId: feed, quantity: 15 },
        { locationId: world.locB1, itemId: feed, quantity: 40 },
        { locationId: world.locClosedA, itemId: feed, quantity: 100 },
        { locationId: world.locA1, itemId: otherFeed, quantity: 7 },
        { locationId: world.locB1, itemId: feed, quantity: 9, itemType: StorageItemType.CHEMICAL },
        { tenantId: foreign.tenantId, locationId: world.locA1, itemId: feed, quantity: 1000 },
        { tenantId: foreign.tenantId, locationId: foreign.locB1, itemId: feed, quantity: 500 },
      ]);

      const rows = await inTx((m) =>
        reader.onHandBySite(m, world.tenantId, {
          kind: 'item',
          key: { itemType: FEED, itemId: feed },
        }),
      );

      expect(bySite(rows)).toEqual([
        { itemType: FEED, itemId: feed, siteId: world.siteA, onHand: 65 },
        { itemType: FEED, itemId: feed, siteId: world.siteB, onHand: 40 },
      ]);
    });

    it('scopes by item list and by tenant with the same per-site fold', async () => {
      // SCENARIO: the same seed shape read through the 'items' scope, the
      // whole-tenant scope, an empty item list, and from the foreign tenant.
      // EXPECTS: 'items' keeps only the listed feeds (not the chemical twin);
      // 'tenant' adds the chemical; an empty list reads nothing; the foreign
      // tenant sees only its own location — its row in THIS tenant's A1 is
      // not on-hand anywhere, because that location is not one of its own.
      const world = await seedWorld();
      const foreign = await seedWorld();
      const feed = randomUUID();
      const otherFeed = randomUUID();
      await seedStock(world.tenantId, [
        { locationId: world.locA1, itemId: feed, quantity: 30, lotNumber: 'LOT-1' },
        { locationId: world.locA2, itemId: feed, quantity: 15 },
        { locationId: world.locB1, itemId: feed, quantity: 40 },
        { locationId: world.locA1, itemId: otherFeed, quantity: 7 },
        { locationId: world.locB1, itemId: feed, quantity: 9, itemType: StorageItemType.CHEMICAL },
        { tenantId: foreign.tenantId, locationId: world.locA1, itemId: feed, quantity: 1000 },
        { tenantId: foreign.tenantId, locationId: foreign.locB1, itemId: feed, quantity: 500 },
      ]);

      const items = await inTx((m) =>
        reader.onHandBySite(m, world.tenantId, {
          kind: 'items',
          itemType: FEED,
          itemIds: [feed, otherFeed],
        }),
      );
      const tenantWide = await inTx((m) =>
        reader.onHandBySite(m, world.tenantId, { kind: 'tenant' }),
      );
      const none = await inTx((m) =>
        reader.onHandBySite(m, world.tenantId, { kind: 'items', itemType: FEED, itemIds: [] }),
      );
      const foreignView = await inTx((m) =>
        reader.onHandBySite(m, foreign.tenantId, {
          kind: 'item',
          key: { itemType: FEED, itemId: feed },
        }),
      );

      const feedA = { itemType: FEED, itemId: feed, siteId: world.siteA, onHand: 45 };
      const feedB = { itemType: FEED, itemId: feed, siteId: world.siteB, onHand: 40 };
      const otherA = { itemType: FEED, itemId: otherFeed, siteId: world.siteA, onHand: 7 };
      const chemicalB = {
        itemType: StorageItemType.CHEMICAL,
        itemId: feed,
        siteId: world.siteB,
        onHand: 9,
      };
      expect(sorted(items)).toEqual(sorted([feedA, feedB, otherA]));
      expect(sorted(tenantWide)).toEqual(sorted([feedA, feedB, otherA, chemicalB]));
      expect(none).toEqual([]);
      expect(foreignView).toEqual([
        { itemType: FEED, itemId: feed, siteId: foreign.siteB, onHand: 500 },
      ]);
    });
  });

  // ── 2. on order ───────────────────────────────────────────────────────────

  describe('StockLedgerReader.onOrder', () => {
    it('counts the unreceived remainder of open orders only', async () => {
      // SCENARIO: the feed is on SUBMITTED (10), APPROVED (5), ORDERED (7) and
      // PARTIALLY_RECEIVED (20 ordered, 12 received) lines; the partial order
      // also carries a fully received line and an over-received one. The same
      // feed is on DRAFT, RECEIVED, CANCELLED and a soft-deleted ORDERED
      // order, and on a foreign tenant's ORDERED order.
      // EXPECTS: 10 + 5 + 7 + (20 − 12) = 30; everything else contributes 0.
      const world = await seedWorld();
      const foreign = await seedWorld();
      const feed = randomUUID();
      const FEED_PO = PurchaseOrderCategory.FEED;
      await seedOrder(world.tenantId, {
        category: FEED_PO,
        status: PurchaseOrderStatus.SUBMITTED,
        lines: [{ itemId: feed, quantity: 10 }],
      });
      await seedOrder(world.tenantId, {
        category: FEED_PO,
        status: PurchaseOrderStatus.APPROVED,
        lines: [{ itemId: feed, quantity: 5 }],
      });
      await seedOrder(world.tenantId, {
        category: FEED_PO,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: feed, quantity: 7 }],
      });
      await seedOrder(world.tenantId, {
        category: FEED_PO,
        status: PurchaseOrderStatus.PARTIALLY_RECEIVED,
        lines: [
          { itemId: feed, quantity: 20, quantityReceived: 12 },
          { itemId: feed, quantity: 4, quantityReceived: 4 },
          { itemId: feed, quantity: 2, quantityReceived: 5 },
        ],
      });
      for (const status of [
        PurchaseOrderStatus.DRAFT,
        PurchaseOrderStatus.RECEIVED,
        PurchaseOrderStatus.CANCELLED,
      ]) {
        await seedOrder(world.tenantId, {
          category: FEED_PO,
          status,
          lines: [{ itemId: feed, quantity: 100 }],
        });
      }
      await seedOrder(world.tenantId, {
        category: FEED_PO,
        status: PurchaseOrderStatus.ORDERED,
        isDeleted: true,
        lines: [{ itemId: feed, quantity: 100 }],
      });
      await seedOrder(foreign.tenantId, {
        category: FEED_PO,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: feed, quantity: 100 }],
      });

      const rows = await inTx((m) =>
        reader.onOrder(m, world.tenantId, { kind: 'item', key: { itemType: FEED, itemId: feed } }),
      );

      expect(rows).toEqual([{ itemType: FEED, itemId: feed, onOrder: 30 }]);
    });

    it('attributes a line to the item type of its order category', async () => {
      // SCENARIO: a HEALTHCARE order for a vaccine, a FEED order for a feed,
      // and a CHEMICAL order whose line reuses the feed's id.
      // EXPECTS: the vaccine's order counts toward its ONE stock identity —
      // the canonical consumable key (stock-identity.ts) — whichever of the
      // two shared types the caller asks with; the feed is 'feed' stock, and
      // the chemical line never lands on the feed's key.
      const world = await seedWorld();
      const vaccine = randomUUID();
      const feed = randomUUID();
      await seedOrder(world.tenantId, {
        category: PurchaseOrderCategory.HEALTHCARE,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: vaccine, quantity: 6 }],
      });
      await seedOrder(world.tenantId, {
        category: PurchaseOrderCategory.FEED,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: feed, quantity: 11 }],
      });
      await seedOrder(world.tenantId, {
        category: PurchaseOrderCategory.CHEMICAL,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: feed, quantity: 9 }],
      });

      const healthcare = await inTx((m) =>
        reader.onOrder(m, world.tenantId, {
          kind: 'item',
          key: { itemType: StorageItemType.HEALTHCARE, itemId: vaccine },
        }),
      );
      const asConsumable = await inTx((m) =>
        reader.onOrder(m, world.tenantId, {
          kind: 'item',
          key: { itemType: StorageItemType.CONSUMABLE, itemId: vaccine },
        }),
      );
      const feedRows = await inTx((m) =>
        reader.onOrder(m, world.tenantId, { kind: 'item', key: { itemType: FEED, itemId: feed } }),
      );
      const tenantWide = await inTx((m) => reader.onOrder(m, world.tenantId, { kind: 'tenant' }));

      expect(healthcare).toEqual([
        { itemType: StorageItemType.CONSUMABLE, itemId: vaccine, onOrder: 6 },
      ]);
      expect(asConsumable).toEqual(healthcare);
      expect(feedRows).toEqual([{ itemType: FEED, itemId: feed, onOrder: 11 }]);
      expect(tenantWide).toHaveLength(3);
      expect(tenantWide).toEqual(
        expect.arrayContaining([
          { itemType: StorageItemType.CONSUMABLE, itemId: vaccine, onOrder: 6 },
          { itemType: FEED, itemId: feed, onOrder: 11 },
          { itemType: StorageItemType.CHEMICAL, itemId: feed, onOrder: 9 },
        ]),
      );
    });
  });

  // ── 3. one item, both tiers ───────────────────────────────────────────────

  describe('LowStockEvaluator.evaluateItem', () => {
    it('bands the pool below, at and above the catalog threshold', async () => {
      // SCENARIO: 30 kg on hand in A1, no open order, no site policy; read
      // against thresholds 50, 30 and 29, and a second item with no stock.
      // EXPECTS: 50 → low_stock, 30 → low_stock (at the threshold is low),
      // 29 → ok; the empty item is out_of_stock with onHand 0.
      const world = await seedWorld();
      const feed = randomUUID();
      const empty = randomUUID();
      await seedStock(world.tenantId, [{ locationId: world.locA1, itemId: feed, quantity: 30 }]);
      const key = { itemType: FEED, itemId: feed };

      const below = await inTx((m) => evaluator.evaluateItem(m, world.tenantId, key, 50));
      const at = await inTx((m) => evaluator.evaluateItem(m, world.tenantId, key, 30));
      const above = await inTx((m) => evaluator.evaluateItem(m, world.tenantId, key, 29));
      const out = await inTx((m) =>
        evaluator.evaluateItem(m, world.tenantId, { itemType: FEED, itemId: empty }, 10),
      );

      const pool = { level: 'pool', itemType: FEED, itemId: feed, onHand: 30, onOrder: 0 };
      expect(below).toEqual({ pool: { ...pool, threshold: 50, band: 'low_stock' }, sites: [] });
      expect(at).toEqual({ pool: { ...pool, threshold: 30, band: 'low_stock' }, sites: [] });
      expect(above).toEqual({ pool: { ...pool, threshold: 29, band: 'ok' }, sites: [] });
      expect(out.pool).toEqual({
        level: 'pool',
        itemType: FEED,
        itemId: empty,
        onHand: 0,
        onOrder: 0,
        threshold: 10,
        band: 'out_of_stock',
      });
    });

    it('lets an open order lift the inventory position above the threshold', async () => {
      // SCENARIO: 20 kg on hand against a threshold of 50, read once before
      // and once after an ORDERED line of 40 kg is placed.
      // EXPECTS: before → low_stock (20 ≤ 50); after → ok (20 + 40 > 50)
      // while on-hand is still below the threshold.
      const world = await seedWorld();
      const feed = randomUUID();
      const key = { itemType: FEED, itemId: feed };
      await seedStock(world.tenantId, [{ locationId: world.locA1, itemId: feed, quantity: 20 }]);

      const before = await inTx((m) => evaluator.evaluateItem(m, world.tenantId, key, 50));
      await seedOrder(world.tenantId, {
        category: PurchaseOrderCategory.FEED,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: feed, quantity: 40 }],
      });
      const after = await inTx((m) => evaluator.evaluateItem(m, world.tenantId, key, 50));

      expect(before.pool).toMatchObject({ onHand: 20, onOrder: 0, band: 'low_stock' });
      expect(after.pool).toEqual({
        level: 'pool',
        itemType: FEED,
        itemId: feed,
        onHand: 20,
        onOrder: 40,
        threshold: 50,
        band: 'ok',
      });
      expect(after.pool.onHand).toBeLessThan(after.pool.threshold);
    });

    it('compares every site with its own policy', async () => {
      // SCENARIO: site A holds 5 + 3 kg (plus 100 kg in a closed location),
      // site B holds 50 kg; policies A = 10, B = 20 and C = 5 (C holds
      // nothing). Another item has a policy at A, and a foreign tenant has a
      // policy for this item at B.
      // EXPECTS: A 8 → low_stock, B 50 → ok, C 0 → out_of_stock; the pool is
      // 58 and ok (threshold 0 = not reorder-controlled); no foreign or
      // other-item policy appears.
      const world = await seedWorld();
      const foreign = await seedWorld();
      const feed = randomUUID();
      await seedStock(world.tenantId, [
        { locationId: world.locA1, itemId: feed, quantity: 5 },
        { locationId: world.locA2, itemId: feed, quantity: 3 },
        { locationId: world.locClosedA, itemId: feed, quantity: 100 },
        { locationId: world.locB1, itemId: feed, quantity: 50 },
      ]);
      await seedPolicy(world.tenantId, world.siteA, feed, 10);
      await seedPolicy(world.tenantId, world.siteB, feed, 20);
      await seedPolicy(world.tenantId, world.siteC, feed, 5);
      await seedPolicy(world.tenantId, world.siteA, randomUUID(), 10);
      await seedPolicy(foreign.tenantId, world.siteB, feed, 1000);

      const evaluation = await inTx((m) =>
        evaluator.evaluateItem(m, world.tenantId, { itemType: FEED, itemId: feed }, 0),
      );

      expect(evaluation.pool).toEqual({
        level: 'pool',
        itemType: FEED,
        itemId: feed,
        onHand: 58,
        onOrder: 0,
        threshold: 0,
        band: 'ok',
      });
      const site = { level: 'site', itemType: FEED, itemId: feed };
      expect(bySite(evaluation.sites)).toEqual([
        { ...site, siteId: world.siteA, onHand: 8, threshold: 10, band: 'low_stock' },
        { ...site, siteId: world.siteB, onHand: 50, threshold: 20, band: 'ok' },
        { ...site, siteId: world.siteC, onHand: 0, threshold: 5, band: 'out_of_stock' },
      ]);
    });

    it('keeps the policy of a soft-deleted site dormant, and wakes it on restore', async () => {
      // SCENARIO: policies A = 10 and C = 5 for a feed that holds nothing at C;
      // site C is soft-deleted (closed), then restored.
      // EXPECTS: while C is deleted, neither evaluateItem nor the tenant list
      // reports C (a closed site is not "out of stock"); A still reads. After
      // the restore, C's out_of_stock reading is back from the same row.
      const world = await seedWorld();
      const feed = randomUUID();
      await seedFeed(world.tenantId, feed, 'Dormant feed', 0);
      await seedStock(world.tenantId, [{ locationId: world.locA1, itemId: feed, quantity: 4 }]);
      await seedPolicy(world.tenantId, world.siteA, feed, 10);
      await seedPolicy(world.tenantId, world.siteC, feed, 5);
      await dataSource.manager.update(Site, { id: world.siteC }, { isDeleted: true });

      const closed = await inTx((m) =>
        evaluator.evaluateItem(m, world.tenantId, { itemType: FEED, itemId: feed }, 0),
      );
      const listed = await inTx((m) => evaluator.listBelowThreshold(m, world.tenantId));

      expect(closed.sites.map((reading) => reading.siteId)).toEqual([world.siteA]);
      expect(
        listed.filter((reading) => reading.itemId === feed).map((reading) => reading.level),
      ).toEqual(['site']);
      expect(
        listed.some((reading) => reading.level === 'site' && reading.siteId === world.siteC),
      ).toBe(false);

      await dataSource.manager.update(Site, { id: world.siteC }, { isDeleted: false });
      const restored = await inTx((m) =>
        evaluator.evaluateItem(m, world.tenantId, { itemType: FEED, itemId: feed }, 0),
      );
      expect(bySite(restored.sites).map((reading) => [reading.siteId, reading.band])).toEqual([
        [world.siteA, 'low_stock'],
        [world.siteC, 'out_of_stock'],
      ]);
    });
  });

  // ── 4. tenant-wide listing ────────────────────────────────────────────────

  describe('LowStockEvaluator.listBelowThreshold', () => {
    it('lists the low pool and only the short sites, most urgent first', async () => {
      // SCENARIO: "Low feed" (minStock 100) holds 40 at A and 10 at B, with
      // policies A = 30 (covered) and B = 50 (short). "Empty feed"
      // (minStock 10) holds nothing. "Unmanaged feed" (minStock 0) holds
      // nothing. "Full feed" (minStock 10) holds 100. A chemical (minStock 10)
      // holds 5 but has 20 on order. A deleted feed (minStock 100) holds
      // nothing.
      // EXPECTS: exactly [Empty pool out_of_stock, Low site B (10/50),
      // Low pool (50/100)] — the out-of-stock first, then by covered fraction.
      const world = await seedWorld();
      const low = randomUUID();
      const empty = randomUUID();
      const unmanaged = randomUUID();
      const full = randomUUID();
      const covered = randomUUID();
      const deleted = randomUUID();
      await seedFeed(world.tenantId, low, 'Low feed', 100);
      await seedFeed(world.tenantId, empty, 'Empty feed', 10);
      await seedFeed(world.tenantId, unmanaged, 'Unmanaged feed', 0);
      await seedFeed(world.tenantId, full, 'Full feed', 10);
      await seedFeed(world.tenantId, deleted, 'Deleted feed', 100, { isDeleted: true });
      await dataSource.manager.save(Chemical, {
        id: covered,
        tenantId: world.tenantId,
        name: 'Covered chemical',
        code: 'CHEM-COVERED',
        type: ChemicalType.DISINFECTANT,
        status: ChemicalStatus.AVAILABLE,
        quantity: 0,
        minStock: 10,
        unit: 'liter',
        isActive: true,
        isDeleted: false,
      });
      await seedStock(world.tenantId, [
        { locationId: world.locA1, itemId: low, quantity: 40 },
        { locationId: world.locB1, itemId: low, quantity: 10 },
        { locationId: world.locA1, itemId: full, quantity: 100 },
        {
          locationId: world.locA1,
          itemId: covered,
          quantity: 5,
          itemType: StorageItemType.CHEMICAL,
        },
      ]);
      await seedPolicy(world.tenantId, world.siteA, low, 30);
      await seedPolicy(world.tenantId, world.siteB, low, 50);
      await seedOrder(world.tenantId, {
        category: PurchaseOrderCategory.CHEMICAL,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: covered, quantity: 20 }],
      });

      const listed = await inTx((m) => evaluator.listBelowThreshold(m, world.tenantId));

      expect(listed).toEqual([
        {
          level: 'pool',
          itemType: FEED,
          itemId: empty,
          onHand: 0,
          onOrder: 0,
          threshold: 10,
          band: 'out_of_stock',
          itemName: 'Empty feed',
          unit: 'kg',
        },
        {
          level: 'site',
          itemType: FEED,
          itemId: low,
          siteId: world.siteB,
          onHand: 10,
          threshold: 50,
          band: 'low_stock',
          itemName: 'Low feed',
          unit: 'kg',
        },
        {
          level: 'pool',
          itemType: FEED,
          itemId: low,
          onHand: 50,
          onOrder: 0,
          threshold: 100,
          band: 'low_stock',
          itemName: 'Low feed',
          unit: 'kg',
        },
      ]);
    });

    it('reads a healthcare product booked under the healthcare ledger type as one pool', async () => {
      // SCENARIO: a vaccine lives in the consumable catalog (minStock 20) and
      // its stock is in the ledger under item type 'healthcare' (5 at A1,
      // the type a HEALTHCARE purchase order receives into) AND 'consumable'
      // (3 at A2, a manual movement).
      // EXPECTS: exactly one pool reading, on the canonical consumable
      // identity (stock-identity.ts): onHand 8, low_stock. Two readings would
      // split one shelf into partial pools and report a stock-out of an item
      // that is on the shelf.
      const world = await seedWorld();
      const vaccine = randomUUID();
      await dataSource.manager.save(Consumable, {
        id: vaccine,
        tenantId: world.tenantId,
        name: 'Vaccine',
        code: 'VACC-1',
        category: ConsumableCategory.OTHER,
        status: ConsumableStatus.AVAILABLE,
        quantity: 0,
        minStock: 20,
        unit: 'dose',
        isActive: true,
        isDeleted: false,
      });
      await seedStock(world.tenantId, [
        {
          locationId: world.locA1,
          itemId: vaccine,
          quantity: 5,
          itemType: StorageItemType.HEALTHCARE,
        },
        {
          locationId: world.locA2,
          itemId: vaccine,
          quantity: 3,
          itemType: StorageItemType.CONSUMABLE,
        },
      ]);

      const listed = await inTx((m) => evaluator.listBelowThreshold(m, world.tenantId));

      expect(listed).toEqual([
        {
          level: 'pool',
          itemType: StorageItemType.CONSUMABLE,
          itemId: vaccine,
          onHand: 8,
          onOrder: 0,
          threshold: 20,
          band: 'low_stock',
          itemName: 'Vaccine',
          unit: 'dose',
        },
      ]);
    });
  });

  // ── 5. the sink, end to end ───────────────────────────────────────────────

  describe('StockMovementService.recordMovement → LowStockDetected (edge trigger)', () => {
    it('emits one v2 event per crossed tier, and nothing while a tier stays low', async () => {
      // SCENARIO: "Sink feed" (pool threshold 100) holds 80 at A1 and 60 at
      // B1, 20 is on order, and site A's policy is 50. OUT 70 from A1, then
      // OUT 5 (both tiers already low), then OUT 5 (A1 drains to zero).
      // EXPECTS: OUT 70 → exactly two LowStockDetected rows, version 2:
      // {site A, 10 vs 50, low_stock} and {pool, 70 on hand + 20 on order vs
      // 100, low_stock}. OUT 5 → no new row. The draining OUT → one new site
      // row (low → out_of_stock) and no pool row (the pool still holds 60).
      const world = await seedWorld();
      const feed = randomUUID();
      await seedFeed(world.tenantId, feed, 'Sink feed', 100);
      await seedStock(world.tenantId, [
        { locationId: world.locA1, itemId: feed, quantity: 80 },
        { locationId: world.locB1, itemId: feed, quantity: 60 },
      ]);
      await seedPolicy(world.tenantId, world.siteA, feed, 50);
      await seedPolicy(world.tenantId, world.siteB, feed, 10);
      await seedOrder(world.tenantId, {
        category: PurchaseOrderCategory.FEED,
        status: PurchaseOrderStatus.ORDERED,
        lines: [{ itemId: feed, quantity: 20 }],
      });
      const out = (quantity: number): RecordMovementInput => ({
        movementType: MovementType.OUT,
        itemType: FEED,
        itemId: feed,
        quantity,
        fromLocationId: world.locA1,
      });

      const first = await move(world.tenantId, out(70));
      const afterFirst = await lowStockEvents(world.tenantId, feed);

      expect(first.lowStockCrossings).toHaveLength(2);
      expect(afterFirst).toHaveLength(2);
      const common = {
        eventType: 'LowStockDetected',
        version: 2,
        tenantId: world.tenantId,
        itemType: FEED,
        itemId: feed,
        itemName: 'Sink feed',
        unit: 'kg',
        severity: 'low_stock',
        // The pair links back to the ONE movement that crossed both tiers.
        causationId: first.saved.id,
        aggregateId: feed,
        aggregateType: 'StorageItem',
      };
      const siteEvent = afterFirst.find((event) => event['level'] === 'site');
      const poolEvent = afterFirst.find((event) => event['level'] === 'pool');
      expect(siteEvent).toEqual(
        expect.objectContaining({
          ...common,
          level: 'site',
          siteId: world.siteA,
          currentQuantity: 10,
          minimumThreshold: 50,
        }),
      );
      expect(poolEvent).toEqual(
        expect.objectContaining({
          ...common,
          level: 'pool',
          currentQuantity: 70,
          onOrderQuantity: 20,
          minimumThreshold: 100,
        }),
      );
      expect(poolEvent).not.toHaveProperty('siteId');

      const second = await move(world.tenantId, out(5));

      expect(second.lowStockCrossings).toEqual([]);
      expect(await lowStockEvents(world.tenantId, feed)).toHaveLength(2);

      const third = await move(world.tenantId, out(5));
      const afterThird = await lowStockEvents(world.tenantId, feed);

      expect(third.lowStockCrossings).toHaveLength(1);
      expect(afterThird).toHaveLength(3);
      expect(afterThird[2]).toEqual(
        expect.objectContaining({
          ...common,
          causationId: third.saved.id,
          level: 'site',
          siteId: world.siteA,
          currentQuantity: 0,
          minimumThreshold: 50,
          severity: 'out_of_stock',
        }),
      );
    });

    it('moves only the source site on a transfer, never the pool', async () => {
      // SCENARIO: "Transfer feed" (pool threshold 120) holds 60 at A1 and 50
      // at B1 — the pool (110) is already low and stays 110 across the move.
      // Policies A = 40, B = 70. TRANSFER 30 from A1 to B1 through
      // recordMovement.
      // EXPECTS: exactly one LowStockDetected: {site A, 30 vs 40, low_stock}.
      // No pool event — had the source leg been counted as a pool decrease,
      // the reconstructed "before" (140) would have been ok and a false pool
      // crossing would appear. Site B recovers (80 > 70) and emits nothing.
      // The ledger shows A = 30, B = 80 and one 'transfer' movement row.
      const world = await seedWorld();
      const feed = randomUUID();
      await seedFeed(world.tenantId, feed, 'Transfer feed', 120);
      await seedStock(world.tenantId, [
        { locationId: world.locA1, itemId: feed, quantity: 60 },
        { locationId: world.locB1, itemId: feed, quantity: 50 },
      ]);
      await seedPolicy(world.tenantId, world.siteA, feed, 40);
      await seedPolicy(world.tenantId, world.siteB, feed, 70);

      const result = await move(world.tenantId, {
        movementType: MovementType.TRANSFER,
        itemType: FEED,
        itemId: feed,
        quantity: 30,
        fromLocationId: world.locA1,
        toLocationId: world.locB1,
      });
      const events = await lowStockEvents(world.tenantId, feed);

      expect(result.lowStockCrossings).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          eventType: 'LowStockDetected',
          version: 2,
          level: 'site',
          siteId: world.siteA,
          currentQuantity: 30,
          minimumThreshold: 40,
          severity: 'low_stock',
        }),
      );
      expect(events.some((event) => event['level'] === 'pool')).toBe(false);

      const onHand = await inTx((m) =>
        reader.onHandBySite(m, world.tenantId, {
          kind: 'item',
          key: { itemType: FEED, itemId: feed },
        }),
      );
      expect(bySite(onHand).map((row) => [row.siteId, row.onHand])).toEqual([
        [world.siteA, 30],
        [world.siteB, 80],
      ]);
      expect(
        await dataSource.manager.count(StockMovement, {
          where: { tenantId: world.tenantId, itemId: feed, movementType: MovementType.TRANSFER },
        }),
      ).toBe(1);
    });
  });
});
