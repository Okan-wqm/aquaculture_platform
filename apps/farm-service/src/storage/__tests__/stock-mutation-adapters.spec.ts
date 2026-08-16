import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { ApproveInventoryCountCommand } from '../commands/approve-inventory-count.command';
import { TransferStockCommand } from '../commands/transfer-stock.command';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { ApproveInventoryCountHandler } from '../handlers/approve-inventory-count.handler';
import { TransferStockHandler } from '../handlers/transfer-stock.handler';
import { StockMovementService } from '../services/stock-movement.service';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    async (
      _dataSource: unknown,
      _schema: string,
      _tenantId: string,
      callback: (runner: { manager: EntityManager }) => Promise<unknown>,
    ) => callback({ manager: globalThis.__stockAdapterManager }),
  ),
  tenantManagerRepo: jest.fn((_manager: EntityManager, entity: unknown) => {
    const repository = globalThis.__stockAdapterRepositories.get(entity);
    if (!repository) throw new Error(`Missing stock adapter repository for ${String(entity)}`);
    return repository;
  }),
}));

declare global {
  var __stockAdapterManager: EntityManager;
  var __stockAdapterRepositories: Map<unknown, unknown>;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const FROM = '55555555-5555-4555-8555-555555555555';
const TO = '66666666-6666-4666-8666-666666666666';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('stock mutation command adapters', () => {
  it('routes transfer through the sole mutation sink with both-site authorization context', async () => {
    const recordMovement = jest.fn().mockResolvedValue({ saved: { id: 'movement-1' } });
    globalThis.__stockAdapterManager = mock<EntityManager>({});
    const handler = new TransferStockHandler(
      mock<DataSource>({}),
      mock<StockMovementService>({ recordMovement }),
    );

    const result = await handler.execute(
      new TransferStockCommand(
        {
          itemType: StorageItemType.FEED,
          itemId: ITEM,
          quantity: 7,
          fromLocationId: FROM,
          toLocationId: TO,
          lotNumber: 'LOT-A',
          idempotencyKey: 'transfer-1',
        },
        TENANT,
        USER,
        'Warehouse Operator',
        [],
        ['site-a', 'site-b'],
      ),
    );

    expect(result).toEqual({ id: 'movement-1' });
    expect(recordMovement).toHaveBeenCalledWith(
      globalThis.__stockAdapterManager,
      expect.objectContaining({
        movementType: MovementType.TRANSFER,
        fromLocationId: FROM,
        toLocationId: TO,
        quantity: 7,
      }),
      expect.objectContaining({
        tenantId: TENANT,
        userId: USER,
        siteAuthorization: { sub: USER, roles: [], assignedSiteIds: ['site-a', 'site-b'] },
      }),
    );
  });

  it('locks approval state and reconciles the live projection through the sink', async () => {
    const count = mock<InventoryCount>({
      id: 'count-1',
      tenantId: TENANT,
      countNumber: 'IC-1',
      storageLocationId: FROM,
      status: InventoryCountStatus.COMPLETED,
      performedBy: OTHER_USER,
    });
    const item = mock<InventoryCountItem>({
      id: 'line-1',
      tenantId: TENANT,
      inventoryCountId: count.id,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      itemName: 'Feed',
      unit: 'kg',
      lotNumber: 'LOT-A',
      expectedQuantity: 100,
      actualQuantity: 93,
      variance: -7,
    });
    const countRepo = {
      findOne: jest.fn().mockResolvedValue(count),
      save: jest.fn(async (row: InventoryCount) => row),
    };
    const itemRepo = { find: jest.fn().mockResolvedValue([item]) };
    globalThis.__stockAdapterManager = mock<EntityManager>({});
    globalThis.__stockAdapterRepositories = new Map<unknown, unknown>([
      [InventoryCount, countRepo],
      [InventoryCountItem, itemRepo],
    ]);
    const reconcilePhysicalCount = jest.fn().mockResolvedValue({ id: 'movement-1' });
    const handler = new ApproveInventoryCountHandler(
      mock<DataSource>({}),
      mock<StockMovementService>({ reconcilePhysicalCount }),
    );

    const result = await handler.execute(
      new ApproveInventoryCountCommand(count.id, TENANT, USER, 'Approver'),
    );

    expect(countRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(reconcilePhysicalCount).toHaveBeenCalledWith(
      globalThis.__stockAdapterManager,
      expect.objectContaining({
        actualQuantity: 93,
        storageLocationId: FROM,
        lotNumber: 'LOT-A',
      }),
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
    );
    expect(result.status).toBe(InventoryCountStatus.APPROVED);
  });

  it('rejects self-approval and duplicate physical keys before mutating stock', async () => {
    const reconcilePhysicalCount = jest.fn();
    const count = mock<InventoryCount>({
      id: 'count-1',
      tenantId: TENANT,
      countNumber: 'IC-1',
      storageLocationId: FROM,
      status: InventoryCountStatus.COMPLETED,
      performedBy: USER,
    });
    const countRepo = { findOne: jest.fn().mockResolvedValue(count), save: jest.fn() };
    const itemRepo = { find: jest.fn() };
    globalThis.__stockAdapterManager = mock<EntityManager>({});
    globalThis.__stockAdapterRepositories = new Map<unknown, unknown>([
      [InventoryCount, countRepo],
      [InventoryCountItem, itemRepo],
    ]);
    const handler = new ApproveInventoryCountHandler(
      mock<DataSource>({}),
      mock<StockMovementService>({ reconcilePhysicalCount }),
    );

    await expect(
      handler.execute(new ApproveInventoryCountCommand(count.id, TENANT, USER)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();

    count.performedBy = OTHER_USER;
    const duplicate = mock<InventoryCountItem>({
      id: 'line-1',
      tenantId: TENANT,
      inventoryCountId: count.id,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      actualQuantity: 1,
    });
    itemRepo.find.mockResolvedValue([
      duplicate,
      mock<InventoryCountItem>({ ...duplicate, id: 'line-2' }),
    ]);
    await expect(
      handler.execute(new ApproveInventoryCountCommand(count.id, TENANT, USER)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });
});
