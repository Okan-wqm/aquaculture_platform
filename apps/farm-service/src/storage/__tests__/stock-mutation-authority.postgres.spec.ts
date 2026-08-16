import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { ConflictException } from '@nestjs/common';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, type QueryRunner } from 'typeorm';

import { TenantClockAuthority } from '../../common/time/tenant-clock.authority';
import { EstablishStockMutationAuthority1808600000000 } from '../../database/migrations/1808600000000-EstablishStockMutationAuthority';
import { Feed, FeedStatus, FeedType, FloatingType } from '../../feed/entities/feed.entity';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { Site, SiteStatus, SiteType } from '../../site/entities/site.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import {
  PurchaseOrder,
  PurchaseOrderCategory,
  PurchaseOrderStatus,
} from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import {
  MovementType,
  StockMovement,
  StockMutationOperationType,
} from '../entities/stock-movement.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StorageLocation, StorageLocationType } from '../entities/storage-location.entity';
import { StorageLotMix } from '../entities/storage-lot-mix.entity';
import { ReceiveDeliveryHandler } from '../handlers/receive-delivery.handler';
import { FeedStockAllocationAuthority } from '../services/feed-stock-allocation.authority';
import { LotMixService } from '../services/lot-mix.service';
import { StockMutationLockAuthority } from '../services/stock-mutation-lock.authority';
import { StockMovementService } from '../services/stock-movement.service';

jest.setTimeout(180_000);

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_REMOTE = '44444444-4444-4444-8444-444444444444';
const SITE_B = '55555555-5555-4555-8555-555555555555';
const LOCATION_A = '66666666-6666-4666-8666-666666666666';
const LOCATION_REMOTE = '77777777-7777-4777-8777-777777777777';
const LOCATION_B = '88888888-8888-4888-8888-888888888888';
const FEED = '99999999-9999-4999-8999-999999999999';
const RECEIPT_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PURCHASE_ORDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PURCHASE_ORDER_ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RECEIPT_OPERATION_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RECEIPT_OPERATION_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RECEIPT_OPERATION_ROLLBACK = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('stock mutation authority on real PostgreSQL', () => {
  let harness: HarnessContext | undefined;
  let authorityDataSource: DataSource | undefined;
  let receiptDataSource: DataSource | undefined;
  let receiveDelivery: ReceiveDeliveryHandler;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await harness.dataSource.query('CREATE SCHEMA authority');
    await harness.dataSource.query(`
      CREATE TABLE authority.sites (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        timezone varchar(50) NOT NULL,
        "isActive" boolean NOT NULL,
        "isDeleted" boolean NOT NULL
      )
    `);
    authorityDataSource = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `stock-authority-${randomBytes(4).toString('hex')}`,
      schema: 'authority',
      entities: [StorageLocation, StorageInventory],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=authority,public' },
    });
    await authorityDataSource.initialize();
    await seedAllocationFixture(authorityDataSource);

    receiptDataSource = await createReceiptDataSource(harness);
    receiveDelivery = createReceiveDeliveryHandler(receiptDataSource);
    await seedReceiptFixture(receiptDataSource);
  });

  afterAll(async () => {
    if (receiptDataSource?.isInitialized) await receiptDataSource.destroy();
    if (authorityDataSource?.isInitialized) await authorityDataSource.destroy();
    await shutdownHarness(harness);
  });

  it('locks and compiles site-first multi-lot FEFO without crossing tenants', async () => {
    const authority = new FeedStockAllocationAuthority(new TenantClockAuthority());
    const allocation = await authorityDataSource!.transaction((manager) =>
      authority.allocate(manager, TENANT_A, {
        feedId: FEED,
        quantityKg: 16,
        occurredAt: new Date('2026-08-16T00:30:00.000Z'),
        preferredSiteId: SITE_A,
      }),
    );

    expect(allocation.poolTotalKg).toBe(19);
    expect(allocation.usedTenantPool).toBe(true);
    expect(allocation.slices.map((slice) => [slice.lotNumber, slice.quantityKg])).toEqual([
      ['LOT-LOCAL-1', 4],
      ['LOT-LOCAL-2', 10],
      ['LOT-REMOTE', 2],
    ]);
  });

  it('serializes an absent physical item key with a transaction advisory lock', async () => {
    const first = authorityDataSource!.createQueryRunner();
    const second = authorityDataSource!.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    try {
      const locks = new StockMutationLockAuthority();
      await locks.acquire(first.manager, TENANT_A, [
        { itemType: StorageItemType.FEED, itemId: FEED },
      ]);
      await second.query(`SET LOCAL lock_timeout = '250ms'`);
      await expect(
        locks.acquire(second.manager, TENANT_A, [{ itemType: StorageItemType.FEED, itemId: FEED }]),
      ).rejects.toThrow();
    } finally {
      await rollbackAndRelease(second);
      await rollbackAndRelease(first);
    }
  });

  it('serializes the tenant-global idempotency namespace independently of item identity', async () => {
    const first = authorityDataSource!.createQueryRunner();
    const second = authorityDataSource!.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    try {
      const locks = new StockMutationLockAuthority();
      await locks.acquireIdempotency(first.manager, TENANT_A, 'shared-operation');
      await second.query(`SET LOCAL lock_timeout = '250ms'`);
      await expect(
        locks.acquireIdempotency(second.manager, TENANT_A, 'shared-operation'),
      ).rejects.toThrow();
    } finally {
      await rollbackAndRelease(second);
      await rollbackAndRelease(first);
    }
  });

  it('commits caller-stable NULL-lot receipts exactly once and keeps every projection in parity', async () => {
    const firstOperation = receiptCommand(RECEIPT_OPERATION_A, 25);
    await Promise.all([
      receiveDelivery.execute(firstOperation),
      receiveDelivery.execute(firstOperation),
    ]);

    const afterConcurrentRetry = await receiptSnapshot(receiptDataSource!);
    expect(afterConcurrentRetry).toMatchObject({
      inventoryRows: 1,
      inventoryQuantity: 25,
      feedQuantity: 25,
      poQuantityReceived: 25,
      movementRows: 1,
      outboxRows: 1,
    });
    expect(afterConcurrentRetry.operationIds).toEqual([RECEIPT_OPERATION_A]);

    await receiveDelivery.execute(firstOperation);
    expect(await receiptSnapshot(receiptDataSource!)).toEqual(afterConcurrentRetry);

    await expect(
      receiveDelivery.execute(receiptCommand(RECEIPT_OPERATION_A, 24)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await receiptSnapshot(receiptDataSource!)).toEqual(afterConcurrentRetry);

    await receiveDelivery.execute(receiptCommand(RECEIPT_OPERATION_B, 25));
    const afterIndependentEqualDelivery = await receiptSnapshot(receiptDataSource!);
    expect(afterIndependentEqualDelivery).toMatchObject({
      inventoryRows: 1,
      inventoryQuantity: 50,
      feedQuantity: 50,
      poQuantityReceived: 50,
      movementRows: 2,
      outboxRows: 2,
    });
    expect(afterIndependentEqualDelivery.operationIds).toEqual([
      RECEIPT_OPERATION_A,
      RECEIPT_OPERATION_B,
    ]);
    expect(afterIndependentEqualDelivery.operationPayloadHashes).toHaveLength(2);
    expect(
      afterIndependentEqualDelivery.operationPayloadHashes.every((hash) =>
        /^[0-9a-f]{64}$/u.test(hash),
      ),
    ).toBe(true);
  });

  it('rolls inventory, Feed.quantity, PO progress, movement and outbox back as one unit', async () => {
    const before = await receiptSnapshot(receiptDataSource!);
    await receiptDataSource!.query(`
      ALTER TABLE farm.outbox_events
        ADD CONSTRAINT reject_receipt_outbox_for_atomicity_test
        CHECK ("eventType" <> 'StockMovementRecorded') NOT VALID
    `);
    try {
      await expect(
        receiveDelivery.execute(receiptCommand(RECEIPT_OPERATION_ROLLBACK, 10)),
      ).rejects.toThrow();
    } finally {
      await receiptDataSource!.query(`
        ALTER TABLE farm.outbox_events
          DROP CONSTRAINT reject_receipt_outbox_for_atomicity_test
      `);
    }

    expect(await receiptSnapshot(receiptDataSource!)).toEqual(before);
  });

  it('enforces NULL-safe physical keys, append-only facts and RETURN provenance', async () => {
    const runner = await createRawLedgerSchema('mutation_ok');
    try {
      await runner.startTransaction();
      await new EstablishStockMutationAuthority1808600000000().up(runner);
      await runner.commitTransaction();

      await runner.query(
        `INSERT INTO storage_inventory
           (id, tenant_id, storage_location_id, item_type, item_id, quantity, lot_number)
         VALUES ($1,$2,$3,'feed',$4,10,NULL)`,
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', TENANT_A, LOCATION_A, FEED],
      );
      await expect(
        runner.query(
          `INSERT INTO storage_inventory
             (id, tenant_id, storage_location_id, item_type, item_id, quantity, lot_number)
           VALUES ($1,$2,$3,'feed',$4,5,NULL)`,
          ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', TENANT_A, LOCATION_A, FEED],
        ),
      ).rejects.toThrow();
      await expect(
        runner.query(
          `INSERT INTO storage_inventory
             (id, tenant_id, storage_location_id, item_type, item_id, quantity, lot_number)
           VALUES ($1,$2,$3,'feed',$4,-1,'NEGATIVE')`,
          ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', TENANT_A, LOCATION_A, FEED],
        ),
      ).rejects.toThrow();

      const sourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
      await runner.query(
        `INSERT INTO stock_movements
           (id, tenant_id, movement_type, item_type, item_id, quantity,
            from_location_id, lot_number, performed_at)
         VALUES ($1,$2,'out','feed',$3,4,$4,'LOT-A',now())`,
        [sourceId, TENANT_A, FEED, LOCATION_A],
      );
      await expect(
        runner.query(`UPDATE stock_movements SET quantity = 3 WHERE id = $1`, [sourceId]),
      ).rejects.toThrow(/append-only/);
      await expect(
        runner.query(
          `INSERT INTO stock_movements
             (id, tenant_id, movement_type, item_type, item_id, quantity,
              to_location_id, lot_number, source_movement_id, performed_at)
           VALUES ($1,$2,'return','feed',$3,1,$4,'WRONG-LOT',$5,now())`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', TENANT_A, FEED, LOCATION_A, sourceId],
        ),
      ).rejects.toThrow(/does not match/);
      await expect(
        runner.query(
          `INSERT INTO stock_movements
             (id, tenant_id, movement_type, item_type, item_id, quantity,
              to_location_id, lot_number, source_movement_id, performed_at)
           VALUES ($1,$2,'return','feed',$3,1,$4,'LOT-A',$5,now())`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', TENANT_A, FEED, LOCATION_A, sourceId],
        ),
      ).resolves.toBeDefined();
      await expect(
        runner.query(
          `INSERT INTO stock_movements
             (id, tenant_id, movement_type, item_type, item_id, quantity,
              to_location_id, lot_number, source_movement_id, performed_at)
           VALUES ($1,$2,'return','feed',$3,4,$4,'LOT-A',$5,now())`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', TENANT_A, FEED, LOCATION_A, sourceId],
        ),
      ).rejects.toThrow(/exceeds the unreturned quantity/);

      await runner.query(
        `INSERT INTO stock_movements
           (id, tenant_id, movement_type, item_type, item_id, quantity,
            from_location_id, allocation_family_key, allocation_root_key,
            allocation_slice_index, performed_at)
         VALUES ($1,$2,'out','feed',$3,1,$4,'family-a','root-a',0,now())`,
        ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', TENANT_A, FEED, LOCATION_A],
      );
      await expect(
        runner.query(
          `INSERT INTO stock_movements
             (id, tenant_id, movement_type, item_type, item_id, quantity,
              from_location_id, allocation_family_key, allocation_root_key,
              allocation_slice_index, performed_at)
           VALUES ($1,$2,'out','feed',$3,1,$4,'family-a','root-a',0,now())`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', TENANT_A, FEED, LOCATION_A],
        ),
      ).rejects.toThrow();

      await expect(
        runner.query(
          `INSERT INTO stock_movements
             (id, tenant_id, movement_type, item_type, item_id, quantity,
              to_location_id, operation_type, operation_id, performed_at)
           VALUES ($1,$2,'in','feed',$3,1,$4,'purchase_order_receipt',$5,now())`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7', TENANT_A, FEED, LOCATION_A, RECEIPT_OPERATION_A],
        ),
      ).rejects.toThrow();

      const operationHash = 'a'.repeat(64);
      await runner.query(
        `INSERT INTO stock_movements
           (id, tenant_id, movement_type, item_type, item_id, quantity,
            to_location_id, operation_type, operation_id,
            operation_payload_hash, operation_item_id, performed_at)
         VALUES ($1,$2,'in','feed',$3,1,$4,'purchase_order_receipt',$5,$6,$7,now())`,
        [
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8',
          TENANT_A,
          FEED,
          LOCATION_A,
          RECEIPT_OPERATION_A,
          operationHash,
          PURCHASE_ORDER_ITEM,
        ],
      );
      await expect(
        runner.query(
          `INSERT INTO stock_movements
             (id, tenant_id, movement_type, item_type, item_id, quantity,
              to_location_id, operation_type, operation_id,
              operation_payload_hash, operation_item_id, performed_at)
           VALUES ($1,$2,'in','feed',$3,1,$4,'purchase_order_receipt',$5,$6,$7,now())`,
          [
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9',
            TENANT_A,
            FEED,
            LOCATION_A,
            RECEIPT_OPERATION_A,
            operationHash,
            PURCHASE_ORDER_ITEM,
          ],
        ),
      ).rejects.toThrow();
    } finally {
      await runner.release();
    }
  });

  it('refuses to guess when pre-existing physical rows are duplicated', async () => {
    const runner = await createRawLedgerSchema('mutation_duplicate');
    try {
      await runner.query(
        `INSERT INTO storage_inventory
           (id, tenant_id, storage_location_id, item_type, item_id, quantity, lot_number)
         VALUES
           ($1,$3,$4,'feed',$5,5,NULL),
           ($2,$3,$4,'feed',$5,6,NULL)`,
        [
          'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
          TENANT_A,
          LOCATION_A,
          FEED,
        ],
      );
      await runner.startTransaction();
      await expect(new EstablishStockMutationAuthority1808600000000().up(runner)).rejects.toThrow(
        /refused duplicate physical key/,
      );
      await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
  });

  async function createRawLedgerSchema(schema: string): Promise<QueryRunner> {
    const runner = harness!.dataSource.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE SCHEMA ${schema}`);
    await runner.query(`SELECT set_config('search_path', $1, false)`, [`${schema},public`]);
    await runner.query(`
      CREATE TABLE storage_inventory (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        storage_location_id uuid NOT NULL,
        item_type varchar(20) NOT NULL,
        item_id uuid NOT NULL,
        quantity numeric(15,2) NOT NULL,
        lot_number varchar(100)
      );
      CREATE TABLE stock_movements (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        movement_type varchar(20) NOT NULL,
        item_type varchar(20) NOT NULL,
        item_id uuid NOT NULL,
        quantity numeric(15,2) NOT NULL,
        from_location_id uuid,
        to_location_id uuid,
        lot_number varchar(100),
        performed_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    return runner;
  }
});

function receiptCommand(operationId: string, quantityReceived: number): ReceiveDeliveryCommand {
  return new ReceiveDeliveryCommand(
    {
      operationId,
      purchaseOrderId: PURCHASE_ORDER,
      storageLocationId: LOCATION_A,
      items: [{ purchaseOrderItemId: PURCHASE_ORDER_ITEM, quantityReceived }],
    },
    TENANT_A,
    RECEIPT_USER,
    [Role.MODULE_MANAGER],
    [SITE_A],
  );
}

async function createReceiptDataSource(harness: HarnessContext): Promise<DataSource> {
  await harness.dataSource.query('CREATE SCHEMA farm');
  const dataSource = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    name: `stock-receipt-${randomBytes(4).toString('hex')}`,
    schema: 'farm',
    entities: [
      Site,
      Supplier,
      Feed,
      StorageLocation,
      StorageInventory,
      StockMovement,
      StorageLotMix,
      PurchaseOrder,
      PurchaseOrderItem,
      FarmOutbox,
    ],
    synchronize: true,
    logging: false,
    extra: { options: '-c search_path=farm,public' },
  });
  await dataSource.initialize();
  await createReceiptOutboxTable(dataSource);

  const tenantSchema = getTenantSchemaName(TENANT_A);
  await dataSource.query(`CREATE SCHEMA "${tenantSchema}"`);
  for (const table of [
    'sites',
    'suppliers',
    'feeds',
    'storage_locations',
    'storage_inventory',
    'stock_movements',
    'storage_lot_mixes',
    'purchase_orders',
    'purchase_order_items',
  ]) {
    await dataSource.query(
      `CREATE TABLE "${tenantSchema}"."${table}" (LIKE "farm"."${table}" INCLUDING ALL)`,
    );
  }
  return dataSource;
}

function createReceiveDeliveryHandler(dataSource: DataSource): ReceiveDeliveryHandler {
  const clock = new TenantClockAuthority();
  const stockMovements = new StockMovementService(
    new LotMixService(),
    new SiteAuthorizationService(),
    new OutboxPublisher(FarmOutbox),
    new StockMutationLockAuthority(),
    new FeedStockAllocationAuthority(clock),
    clock,
  );
  return new ReceiveDeliveryHandler(dataSource, stockMovements);
}

async function seedReceiptFixture(dataSource: DataSource): Promise<void> {
  await runInTenantTransaction(dataSource, 'farm', TENANT_A, async (queryRunner) => {
    const manager = queryRunner.manager;
    await manager.save(
      manager.create(Site, {
        id: SITE_A,
        tenantId: TENANT_A,
        name: 'Receipt Site',
        code: 'RECEIPT-SITE',
        type: SiteType.LAND_BASED,
        country: 'NO',
        timezone: 'UTC',
        status: SiteStatus.ACTIVE,
        isActive: true,
        isDeleted: false,
        createdBy: RECEIPT_USER,
        updatedBy: RECEIPT_USER,
      }),
    );
    await manager.save(
      manager.create(Feed, {
        id: FEED,
        tenantId: TENANT_A,
        name: 'Receipt Feed',
        code: 'RECEIPT-FEED',
        type: FeedType.GROWER,
        floatingType: FloatingType.FLOATING,
        status: FeedStatus.OUT_OF_STOCK,
        quantity: 0,
        minStock: 0,
        unit: 'kg',
        currency: 'NOK',
        isActive: true,
        isDeleted: false,
        createdBy: RECEIPT_USER,
        updatedBy: RECEIPT_USER,
      }),
    );
    await manager.save(
      manager.create(StorageLocation, {
        id: LOCATION_A,
        tenantId: TENANT_A,
        siteId: SITE_A,
        name: 'Receipt Warehouse',
        code: 'RECEIPT-WH',
        type: StorageLocationType.WAREHOUSE,
        capacityUnit: 'm3',
        usedCapacity: 0,
        isActive: true,
        isDeleted: false,
        createdBy: RECEIPT_USER,
        updatedBy: RECEIPT_USER,
      }),
    );
    await manager.save(
      manager.create(PurchaseOrder, {
        id: PURCHASE_ORDER,
        tenantId: TENANT_A,
        orderNumber: 'PO-RECEIPT-1',
        category: PurchaseOrderCategory.FEED,
        supplierName: 'Receipt Supplier',
        status: PurchaseOrderStatus.ORDERED,
        currency: 'NOK',
        createdBy: RECEIPT_USER,
        isDeleted: false,
      }),
    );
    await manager.save(
      manager.create(PurchaseOrderItem, {
        id: PURCHASE_ORDER_ITEM,
        tenantId: TENANT_A,
        purchaseOrderId: PURCHASE_ORDER,
        itemId: FEED,
        itemName: 'Receipt Feed',
        quantity: 100,
        unit: 'kg',
        quantityReceived: 0,
        isFullyReceived: false,
      }),
    );
  });
}

interface ReceiptSnapshot {
  readonly inventoryRows: number;
  readonly inventoryQuantity: number;
  readonly feedQuantity: number;
  readonly poQuantityReceived: number;
  readonly movementRows: number;
  readonly outboxRows: number;
  readonly operationIds: string[];
  readonly operationPayloadHashes: string[];
}

async function receiptSnapshot(dataSource: DataSource): Promise<ReceiptSnapshot> {
  const tenantSchema = getTenantSchemaName(TENANT_A);
  const inventory: Array<{ row_count: string; quantity: string }> = await dataSource.query(
    `SELECT count(*)::text AS row_count, COALESCE(sum(quantity), 0)::text AS quantity
       FROM "${tenantSchema}".storage_inventory
      WHERE tenant_id = $1
        AND storage_location_id = $2
        AND item_type = 'feed'
        AND item_id = $3
        AND lot_number IS NULL`,
    [TENANT_A, LOCATION_A, FEED],
  );
  const feeds: Array<{ quantity: string }> = await dataSource.query(
    `SELECT quantity::text AS quantity
       FROM "${tenantSchema}".feeds
      WHERE "tenantId" = $1 AND id = $2`,
    [TENANT_A, FEED],
  );
  const poItems: Array<{ quantity_received: string }> = await dataSource.query(
    `SELECT quantity_received::text AS quantity_received
       FROM "${tenantSchema}".purchase_order_items
      WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, PURCHASE_ORDER_ITEM],
  );
  const movements: Array<{ operation_id: string; operation_payload_hash: string }> =
    await dataSource.query(
      `SELECT operation_id::text AS operation_id,
              btrim(operation_payload_hash) AS operation_payload_hash
         FROM "${tenantSchema}".stock_movements
        WHERE tenant_id = $1
          AND operation_type = $2
        ORDER BY operation_id`,
      [TENANT_A, StockMutationOperationType.PURCHASE_ORDER_RECEIPT],
    );
  const outbox: Array<{ row_count: string }> = await dataSource.query(
    `SELECT count(*)::text AS row_count
       FROM farm.outbox_events
      WHERE "tenantId" = $1 AND "eventType" = 'StockMovementRecorded'`,
    [TENANT_A],
  );
  return {
    inventoryRows: Number(inventory[0]?.row_count ?? 0),
    inventoryQuantity: Number(inventory[0]?.quantity ?? 0),
    feedQuantity: Number(feeds[0]?.quantity ?? 0),
    poQuantityReceived: Number(poItems[0]?.quantity_received ?? 0),
    movementRows: movements.length,
    outboxRows: Number(outbox[0]?.row_count ?? 0),
    operationIds: movements.map((movement) => movement.operation_id),
    operationPayloadHashes: movements.map((movement) => movement.operation_payload_hash),
  };
}

async function createReceiptOutboxTable(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE farm.outbox_events (
      "id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      "eventType" varchar(100) NOT NULL,
      "tenantId" uuid,
      "aggregateId" uuid,
      "payload" jsonb NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "publishedAt" timestamptz,
      "retryCount" integer NOT NULL DEFAULT 0,
      "lastError" text,
      "nextAttemptAt" timestamptz,
      "idempotencyKey" varchar(255),
      "isDeadLettered" boolean NOT NULL DEFAULT false,
      "leasedAt" timestamptz,
      "leasedBy" varchar(128)
    )
  `);
}

async function rollbackAndRelease(runner: QueryRunner): Promise<void> {
  if (runner.isTransactionActive) await runner.rollbackTransaction();
  await runner.release();
}

async function seedAllocationFixture(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `INSERT INTO authority.sites VALUES
      ($1,$4,'Pacific/Kiritimati',true,false),
      ($2,$4,'America/Adak',true,false),
      ($3,$5,'UTC',true,false)`,
    [SITE_A, SITE_REMOTE, SITE_B, TENANT_A, TENANT_B],
  );
  await dataSource.manager.save([
    dataSource.manager.create(StorageLocation, {
      id: LOCATION_A,
      tenantId: TENANT_A,
      siteId: SITE_A,
      name: 'Local',
      code: 'LOCAL',
      type: StorageLocationType.WAREHOUSE,
      capacityUnit: 'm3',
      usedCapacity: 0,
      isActive: true,
      isDeleted: false,
    }),
    dataSource.manager.create(StorageLocation, {
      id: LOCATION_REMOTE,
      tenantId: TENANT_A,
      siteId: SITE_REMOTE,
      name: 'Remote',
      code: 'REMOTE',
      type: StorageLocationType.WAREHOUSE,
      capacityUnit: 'm3',
      usedCapacity: 0,
      isActive: true,
      isDeleted: false,
    }),
    dataSource.manager.create(StorageLocation, {
      id: LOCATION_B,
      tenantId: TENANT_B,
      siteId: SITE_B,
      name: 'Other tenant',
      code: 'OTHER',
      type: StorageLocationType.WAREHOUSE,
      capacityUnit: 'm3',
      usedCapacity: 0,
      isActive: true,
      isDeleted: false,
    }),
  ]);
  await dataSource.manager.save([
    dataSource.manager.create(StorageInventory, {
      tenantId: TENANT_A,
      storageLocationId: LOCATION_A,
      itemType: StorageItemType.FEED,
      itemId: FEED,
      quantity: 20,
      unit: 'kg',
      lotNumber: 'LOT-EXPIRED',
      expiryDate: new Date('2026-08-16T00:00:00.000Z'),
      receivedDate: new Date('2026-07-01T00:00:00.000Z'),
    }),
    dataSource.manager.create(StorageInventory, {
      tenantId: TENANT_A,
      storageLocationId: LOCATION_A,
      itemType: StorageItemType.FEED,
      itemId: FEED,
      quantity: 4,
      unit: 'kg',
      lotNumber: 'LOT-LOCAL-1',
      expiryDate: new Date('2026-09-01T00:00:00.000Z'),
      receivedDate: new Date('2026-07-02T00:00:00.000Z'),
    }),
    dataSource.manager.create(StorageInventory, {
      tenantId: TENANT_A,
      storageLocationId: LOCATION_A,
      itemType: StorageItemType.FEED,
      itemId: FEED,
      quantity: 10,
      unit: 'kg',
      lotNumber: 'LOT-LOCAL-2',
      expiryDate: new Date('2026-10-01T00:00:00.000Z'),
      receivedDate: new Date('2026-07-03T00:00:00.000Z'),
    }),
    dataSource.manager.create(StorageInventory, {
      tenantId: TENANT_A,
      storageLocationId: LOCATION_REMOTE,
      itemType: StorageItemType.FEED,
      itemId: FEED,
      quantity: 5,
      unit: 'kg',
      lotNumber: 'LOT-REMOTE',
      expiryDate: new Date('2026-08-16T00:00:00.000Z'),
      receivedDate: new Date('2026-07-01T00:00:00.000Z'),
    }),
    dataSource.manager.create(StorageInventory, {
      tenantId: TENANT_B,
      storageLocationId: LOCATION_B,
      itemType: StorageItemType.FEED,
      itemId: FEED,
      quantity: 100,
      unit: 'kg',
      lotNumber: 'LOT-OTHER-TENANT',
      expiryDate: new Date('2026-08-18T00:00:00.000Z'),
      receivedDate: new Date('2026-07-01T00:00:00.000Z'),
    }),
  ]);
}
