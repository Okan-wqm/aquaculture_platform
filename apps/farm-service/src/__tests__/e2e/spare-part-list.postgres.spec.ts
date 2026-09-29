/**
 * The spare-part list against a REAL PostgreSQL (FARM-HIGH-338, V-B1-12 of the
 * B1a-1 verifier round).
 *
 * ## Why this suite has to hit a real database
 *
 * The list selects one page in SQL. Its stock filters and sorts read
 * `sparePartStockSql` — the SQL rendering of `deriveSparePartStatus` +
 * `poolStockBand` — so the ONE status rule exists twice: in TypeScript (every
 * resolved `status` field) and in SQL (which parts a filter selects). Only
 * Postgres can prove the two agree, and only Postgres evaluates the soft-delete
 * and tenant predicates, the order-status and category filters and the
 * `numeric` arithmetic of the correlated subqueries.
 *
 * ## Shape
 *
 * One tenant schema derived from the synchronize-built `farm` source, entered
 * through the real `runInTenantRead` boundary. The part grid covers every band
 * of the rule: active/inactive × reorder point 0/5 × on-hand 0/3/5/8 × on
 * order 0/2/10. Noise the SQL must ignore is written next to it: stock in a
 * soft-deleted location, another tenant's stock and order lines in the SAME
 * schema, a DRAFT and a CANCELLED order, a fully received line.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, DeepPartial, ObjectLiteral } from 'typeorm';

import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { SparePart, SparePartStatus } from '../../maintenance/entities/spare-part.entity';
import { ListSparePartsHandler } from '../../maintenance/handlers/list-spare-parts.handler';
import { ListSparePartsQuery } from '../../maintenance/queries/list-spare-parts.query';
import { sparePartStockSql } from '../../maintenance/services/spare-part-stock.sql';
import {
  deriveSparePartStatus,
  SparePartStockReader,
} from '../../maintenance/services/spare-part-stock.reader';
import { PurchaseOrderItem } from '../../storage/entities/purchase-order-item.entity';
import {
  PurchaseOrder,
  PurchaseOrderCategory,
  PurchaseOrderStatus,
} from '../../storage/entities/purchase-order.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import { StockLedgerReader } from '../../storage/services/low-stock/stock-ledger.reader';
import { Supplier } from '../../supplier/entities/supplier.entity';

import { createTenantSchemaDerived } from './helpers/tenant-schema-harness';

const TENANT = '6a2f1c3d-4e5b-4a7c-8d9e-0f1a2b3c4d5e';
const OTHER_TENANT = '0e9d8c7b-6a5f-4e4d-9c3b-2a1f0e9d8c7b';
const SITE = '8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
const USER = '00000000-0000-0000-0000-000000000000';

interface GridPart {
  id: string;
  name: string;
  isActive: boolean;
  reorderPoint: number;
  onHand: number;
  onOrder: number;
  expected: SparePartStatus;
}

describe('ListSparePartsHandler — page selected in SQL, one status rule (real Postgres)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let handler: ListSparePartsHandler;
  let seq = 0;
  const grid: GridPart[] = [];

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-spare-part-list-${randomBytes(4).toString('hex')}`,
      entities: [
        SparePart,
        Supplier,
        EquipmentType,
        StorageLocation,
        StorageInventory,
        PurchaseOrder,
        PurchaseOrderItem,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT));
    handler = new ListSparePartsHandler(dataSource);
    await seedGrid();
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

  async function location(isDeleted: boolean, tenantId: string = TENANT): Promise<string> {
    seq += 1;
    const row = await insert(StorageLocation, {
      tenantId,
      siteId: SITE,
      code: `LOC-${seq}`,
      name: `Store ${seq}`,
      usedCapacity: 0,
      isDeleted,
    });
    return row.id;
  }

  async function order(
    tenantId: string,
    status: PurchaseOrderStatus,
    lines: Array<{ itemId: string; quantity: number; quantityReceived?: number }>,
    category: PurchaseOrderCategory = PurchaseOrderCategory.SPARE_PART,
  ): Promise<void> {
    seq += 1;
    const po = await insert(PurchaseOrder, {
      tenantId,
      orderNumber: `PO-${seq}`,
      category,
      supplierName: 'Nordic Supply AS',
      status,
      isDeleted: false,
      createdBy: USER,
    });
    for (const line of lines) {
      await insert(PurchaseOrderItem, {
        tenantId,
        purchaseOrderId: po.id,
        itemId: line.itemId,
        itemName: 'Ordered part',
        quantity: line.quantity,
        unit: 'piece',
        quantityReceived: line.quantityReceived ?? 0,
      });
    }
  }

  async function seedGrid(): Promise<void> {
    const liveLocation = await location(false);
    const closedLocation = await location(true);
    const foreignLocation = await location(false, OTHER_TENANT);
    let index = 0;
    for (const isActive of [true, false]) {
      for (const reorderPoint of [0, 5]) {
        for (const onHand of [0, 3, 5, 8]) {
          for (const onOrder of [0, 2, 10]) {
            index += 1;
            const name = `Part ${String(index).padStart(3, '0')}`;
            const saved = await insert(SparePart, {
              tenantId: TENANT,
              code: `SP-${String(index).padStart(6, '0')}`,
              name,
              partNumber: `PN-${index}`,
              isActive,
              reorderPoint,
              minStock: 0,
              maxStock: 0,
              unit: 'piece',
              storageLocationId: liveLocation,
            });
            const id = saved.id;
            if (onHand > 0) {
              await insert(StorageInventory, {
                tenantId: TENANT,
                storageLocationId: liveLocation,
                itemType: StorageItemType.SPARE_PART,
                itemId: id,
                quantity: onHand,
                unit: 'piece',
              });
            }
            // Noise the on-hand SQL must ignore: a closed location and another
            // tenant's lot of the same part id, written into this schema.
            await insert(StorageInventory, {
              tenantId: TENANT,
              storageLocationId: closedLocation,
              itemType: StorageItemType.SPARE_PART,
              itemId: id,
              quantity: 50,
              unit: 'piece',
            });
            await insert(StorageInventory, {
              tenantId: OTHER_TENANT,
              storageLocationId: foreignLocation,
              itemType: StorageItemType.SPARE_PART,
              itemId: id,
              quantity: 70,
              unit: 'piece',
            });
            if (onOrder > 0) {
              await order(TENANT, PurchaseOrderStatus.ORDERED, [
                { itemId: id, quantity: onOrder + 4, quantityReceived: 4 },
              ]);
            }
            // Noise the on-order SQL must ignore: a DRAFT, a CANCELLED and a
            // fully received order, another tenant's open line, a FEED order.
            await order(TENANT, PurchaseOrderStatus.DRAFT, [{ itemId: id, quantity: 30 }]);
            await order(TENANT, PurchaseOrderStatus.CANCELLED, [{ itemId: id, quantity: 30 }]);
            await order(TENANT, PurchaseOrderStatus.PARTIALLY_RECEIVED, [
              { itemId: id, quantity: 6, quantityReceived: 6 },
            ]);
            await order(OTHER_TENANT, PurchaseOrderStatus.ORDERED, [{ itemId: id, quantity: 30 }]);
            await order(
              TENANT,
              PurchaseOrderStatus.ORDERED,
              [{ itemId: id, quantity: 30 }],
              PurchaseOrderCategory.FEED,
            );
            grid.push({
              id,
              name,
              isActive,
              reorderPoint,
              onHand,
              onOrder,
              expected: deriveSparePartStatus({ isActive, reorderPoint }, onHand, onOrder),
            });
          }
        }
      }
    }
  }

  function list(query: Partial<ListSparePartsQuery>): ReturnType<ListSparePartsHandler['execute']> {
    return handler.execute(
      new ListSparePartsQuery(
        TENANT,
        query.filter,
        query.page ?? 1,
        query.limit ?? 100,
        query.sortBy ?? 'name',
        query.sortOrder ?? 'ASC',
      ),
    );
  }

  it('renders the ONE status rule in SQL exactly as TypeScript derives it', async () => {
    // SCENARIO: every band of the rule (48 parts) plus the ignored noise.
    // EXPECTS: the SQL on-hand, on-order and status of every part equal the
    // grid, the TypeScript rule, and the ledger reader's derived view.
    const rows: Array<{ id: string; onHand: string; onOrder: string; status: string }> =
      await runInTenantRead(dataSource, 'farm', TENANT, async (queryRunner) => {
        const stock = sparePartStockSql(queryRunner.manager, 'sp');
        return tenantManagerRepo(queryRunner.manager, SparePart, TENANT)
          .createQueryBuilder('sp')
          .select('sp.id', 'id')
          .addSelect(stock.onHand, 'onHand')
          .addSelect(stock.onOrder, 'onOrder')
          .addSelect(stock.status, 'status')
          .setParameters(stock.parameters)
          .getRawMany();
      });
    const views = await runInTenantRead(dataSource, 'farm', TENANT, (queryRunner) =>
      new SparePartStockReader(new StockLedgerReader()).read(
        queryRunner.manager,
        TENANT,
        grid.map((part) => ({
          id: part.id,
          isActive: part.isActive,
          reorderPoint: part.reorderPoint,
        })),
      ),
    );

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows).toHaveLength(grid.length);
    for (const part of grid) {
      const row = byId.get(part.id);
      expect({
        id: part.id,
        onHand: Number(row?.onHand),
        onOrder: Number(row?.onOrder),
        status: row?.status,
      }).toEqual({
        id: part.id,
        onHand: part.onHand,
        onOrder: part.onOrder,
        status: part.expected,
      });
      expect(views.get(part.id)?.status).toBe(part.expected);
    }
    // The grid really covers every status.
    expect(new Set(grid.map((part) => part.expected))).toEqual(
      new Set(Object.values(SparePartStatus)),
    );
  });

  it('filters by the derived status in SQL and counts the whole match', async () => {
    // SCENARIO: status filters, the low-stock flag and the out-of-stock flag.
    // EXPECTS: exactly the grid parts the TypeScript rule puts in each status.
    const expectedIds = (statuses: SparePartStatus[]): string[] =>
      grid
        .filter((part) => statuses.includes(part.expected))
        .map((part) => part.id)
        .sort();
    const ids = (result: { items: readonly SparePart[] }): string[] =>
      result.items.map((part) => part.id).sort();

    const onOrderOrLow = await list({
      filter: { status: [SparePartStatus.ON_ORDER, SparePartStatus.LOW_STOCK] },
    });
    expect(ids(onOrderOrLow)).toEqual(
      expectedIds([SparePartStatus.ON_ORDER, SparePartStatus.LOW_STOCK]),
    );
    expect(onOrderOrLow.total).toBe(onOrderOrLow.items.length);

    expect(ids(await list({ filter: { isLowStock: true } }))).toEqual(
      expectedIds([SparePartStatus.LOW_STOCK]),
    );
    expect(ids(await list({ filter: { isOutOfStock: true } }))).toEqual(
      expectedIds([SparePartStatus.OUT_OF_STOCK]),
    );
  });

  it('loads only the requested page, in a total order', async () => {
    // SCENARIO: 48 parts, 10 per page, by name; then by derived on-hand, descending.
    // EXPECTS: page 2 is parts 11–20 by name with total 48; the on-hand sort
    // orders by the ledger quantity, ties broken by id.
    const page2 = await list({ page: 2, limit: 10 });
    expect(page2.total).toBe(grid.length);
    expect(page2.items.map((part) => part.name)).toEqual(
      [...grid]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(10, 20)
        .map((part) => part.name),
    );

    const byQuantity = await list({ sortBy: 'quantity', sortOrder: 'DESC', limit: 12 });
    expect(byQuantity.items.map((part) => part.id)).toEqual(
      [...grid]
        .sort((a, b) => b.onHand - a.onHand || a.id.localeCompare(b.id))
        .slice(0, 12)
        .map((part) => part.id),
    );
  });

  it('scopes every fact to the tenant and the live locations', async () => {
    // SCENARIO: a part with no stock of its own in a live location of this tenant,
    // only closed-location and other-tenant stock. EXPECTS: reads OUT_OF_STOCK.
    const outOfStock = grid.find(
      (part) => part.isActive && part.onHand === 0 && part.onOrder === 0,
    );
    expect(outOfStock?.expected).toBe(SparePartStatus.OUT_OF_STOCK);
    const listed = await list({ filter: { status: [SparePartStatus.OUT_OF_STOCK] } });
    expect(listed.items.map((part) => part.id)).toContain(outOfStock?.id);
  });
});
