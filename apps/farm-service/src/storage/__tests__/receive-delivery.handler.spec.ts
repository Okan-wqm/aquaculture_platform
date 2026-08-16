/**
 * ReceiveDeliveryHandler unit tests (P-08 / stock SSoT Phase 0).
 *
 * The handler previously wrote `storage_inventory` + `stock_movements` rows
 * DIRECTLY, bypassing `StockMovementService.recordMovement` — so a PO receipt
 * never rolled up onto `Feed.quantity` (invisible to the consumption
 * forecast), carried no idempotency key, and emitted no outbox event. These
 * tests pin the corrected contract:
 *   - every received item flows through recordMovement (IN) on the SAME
 *     opaque tenant mutation session (roll-up + lot-mix + audit row live there);
 *   - the idempotency key is deterministic per stable (receiptId, poItem);
 *   - PO + item progress is loaded and locked inside that same transaction;
 *   - StockMovementRecorded remains owned by the canonical movement authority;
 *   - an idempotent replay also skips the PO-item progress mutation;
 *   - over-receive still rejects; PO status transitions unchanged;
 *   - SEC-HIGH-051 site-authorization context reaches the movement sink;
 *   - the handler no longer touches StorageInventory/StockMovement repos.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';

import {
  purchaseOrderReceiptMovementKeyV1,
  ReceiveDeliveryHandler,
} from '../handlers/receive-delivery.handler';
import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import {
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderCategory,
} from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { MovementType } from '../entities/stock-movement.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const PO_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_A = '55555555-5555-4555-8555-555555555555';
const ITEM_B = '66666666-6666-4666-8666-666666666666';
const RECEIPT = '77777777-7777-4777-8777-777777777777';
const TRANSACTION_INSTANT = '2026-08-08T12:30:00.000Z';

describe('ReceiveDeliveryHandler', () => {
  let handler: ReceiveDeliveryHandler;
  let innerPoRepo: jest.Mocked<Repository<PurchaseOrder>>;
  let innerItemRepo: jest.Mocked<Repository<PurchaseOrderItem>>;
  let stockMovementService: { recordMovement: jest.Mock };
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  const makeItem = (overrides: Partial<PurchaseOrderItem> = {}): PurchaseOrderItem =>
    Object.assign(new PurchaseOrderItem(), {
      id: 'poi-1',
      tenantId: TENANT,
      itemId: ITEM_A,
      itemName: 'Starter Feed 2mm',
      quantity: 100,
      quantityReceived: 0,
      isFullyReceived: false,
      unit: 'kg',
      ...overrides,
    });

  const makePo = (
    items: PurchaseOrderItem[],
    overrides: Partial<PurchaseOrder> = {},
  ): PurchaseOrder =>
    Object.assign(new PurchaseOrder(), {
      id: PO_ID,
      tenantId: TENANT,
      orderNumber: 'PO-0007',
      category: PurchaseOrderCategory.FEED,
      status: PurchaseOrderStatus.ORDERED,
      isDeleted: false,
      items,
      ...overrides,
    });

  const makeCommand = (
    items: Array<{
      itemId: string;
      quantityReceived: number;
      lotNumber?: string;
      expiryDate?: string;
    }>,
  ): ReceiveDeliveryCommand =>
    new ReceiveDeliveryCommand(
      { receiptId: RECEIPT, purchaseOrderId: PO_ID, storageLocationId: LOCATION, items },
      TENANT,
      USER,
      [Role.MODULE_MANAGER],
      ['site-1'],
    );

  const movementResult = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    saved: {
      id: 'mov-1',
      movementType: MovementType.IN,
      itemType: StorageItemType.FEED,
      itemId: ITEM_A,
      itemName: 'Starter Feed 2mm',
      quantity: 40,
      unit: 'kg',
      fromLocationId: null,
      toLocationId: LOCATION,
      lotNumber: 'LOT-9',
    },
    currentTotal: 0,
    idempotentHit: false,
    warnings: [],
    ...overrides,
  });

  const loadPo = (po: PurchaseOrder | null): void => {
    innerPoRepo.findOne.mockResolvedValue(po);
    innerItemRepo.find.mockResolvedValue(po?.items ?? []);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    innerPoRepo = createMockRepository<PurchaseOrder>();
    innerItemRepo = createMockRepository<PurchaseOrderItem>();
    innerPoRepo.create.mockImplementation((data: unknown) => data as PurchaseOrder);
    innerPoRepo.save.mockImplementation((data: unknown) => Promise.resolve(data as PurchaseOrder));
    innerItemRepo.create.mockImplementation((data: unknown) => data as PurchaseOrderItem);
    innerItemRepo.save.mockImplementation((data: unknown) =>
      Promise.resolve(data as PurchaseOrderItem),
    );

    mockManager.getRepository.mockImplementation(((entity: unknown) =>
      entity === PurchaseOrderItem ? innerItemRepo : innerPoRepo) as never);
    mockQueryRunner.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('AS "mutationInstant"') ? [{ mutationInstant: TRANSACTION_INSTANT }] : [],
      ),
    );

    stockMovementService = { recordMovement: jest.fn().mockResolvedValue(movementResult()) };
    handler = new ReceiveDeliveryHandler(mockDataSource as never, stockMovementService as never);
  });

  it('routes every received item through StockMovementService.recordMovement (IN) on the tx session', async () => {
    const po = makePo([makeItem()]);
    loadPo(po);

    await handler.execute(
      makeCommand([
        { itemId: ITEM_A, quantityReceived: 40, lotNumber: 'LOT-9', expiryDate: '2027-01-01' },
      ]),
    );

    expect(stockMovementService.recordMovement).toHaveBeenCalledTimes(1);
    const [passedSession, input, ctx] = stockMovementService.recordMovement.mock.calls[0];
    expect(passedSession).not.toBe(mockManager);
    expect(input).toMatchObject({
      movementType: MovementType.IN,
      itemType: StorageItemType.FEED,
      itemId: ITEM_A,
      quantity: 40,
      toLocationId: LOCATION,
      lotNumber: 'LOT-9',
      reference: 'PO: PO-0007',
      idempotencyKey: purchaseOrderReceiptMovementKeyV1(RECEIPT, 'poi-1'),
    });
    expect(input.expiryDate).toBeInstanceOf(Date);
    expect(ctx).toMatchObject({ tenantId: TENANT, userId: USER });
  });

  it('passes SEC-HIGH-051 site-authorization context to the movement sink', async () => {
    loadPo(makePo([makeItem()]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 10 }]));

    const [, , ctx] = stockMovementService.recordMovement.mock.calls[0];
    expect(ctx.siteAuthorization).toEqual({
      sub: USER,
      roles: [Role.MODULE_MANAGER],
      assignedSiteIds: ['site-1'],
    });
  });

  it('derives one stable receipt-line identity independent of mutable PO progress', async () => {
    const item = makeItem({ quantityReceived: 40 });
    loadPo(makePo([item]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 25 }]));

    const [, input] = stockMovementService.recordMovement.mock.calls[0];
    expect(input.idempotencyKey).toBe(purchaseOrderReceiptMovementKeyV1(RECEIPT, 'poi-1'));
  });

  it('on idempotent replay skips the PO-item progress mutation', async () => {
    const item = makeItem();
    loadPo(makePo([item]));
    stockMovementService.recordMovement.mockResolvedValue(movementResult({ idempotentHit: true }));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(innerItemRepo.save).not.toHaveBeenCalled();
    expect(item.quantityReceived).toBe(0);
  });

  it('rejects over-receive in the same transaction after ruling out exact replay', async () => {
    loadPo(makePo([makeItem({ quantity: 100, quantityReceived: 90 })]));

    await expect(
      handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 20 }])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stockMovementService.recordMovement).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a PO that is not in a receivable status', async () => {
    loadPo(makePo([makeItem()], { status: PurchaseOrderStatus.DRAFT }));

    await expect(
      handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 1 }])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown purchase order', async () => {
    loadPo(null);

    await expect(
      handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 1 }])),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('propagates movement-sink failures so the whole receipt rolls back', async () => {
    loadPo(makePo([makeItem()]));
    stockMovementService.recordMovement.mockRejectedValue(
      new NotFoundException('Storage location not found'),
    );

    await expect(
      handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 5 }])),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks the PO RECEIVED with actualDeliveryDate when every item is fully received', async () => {
    const item = makeItem({ quantity: 100, quantityReceived: 60 });
    loadPo(makePo([item]));

    const result = await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(item.quantityReceived).toBe(100);
    expect(item.isFullyReceived).toBe(true);
    expect(result.status).toBe(PurchaseOrderStatus.RECEIVED);
    expect(result.actualDeliveryDate).toEqual(new Date(TRANSACTION_INSTANT));
  });

  it('marks the PO PARTIALLY_RECEIVED when some quantity remains outstanding', async () => {
    const item = makeItem({ quantity: 100, quantityReceived: 0 });
    loadPo(makePo([item]));

    const result = await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(result.status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);
  });

  it('admits an exact receipt replay after the PO reached RECEIVED without rewriting progress', async () => {
    const item = makeItem({ quantityReceived: 100, isFullyReceived: true });
    const po = makePo([item], {
      status: PurchaseOrderStatus.RECEIVED,
      actualDeliveryDate: new Date('2026-08-01T10:00:00.000Z'),
    });
    loadPo(po);
    stockMovementService.recordMovement.mockResolvedValue(movementResult({ idempotentHit: true }));

    const result = await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 100 }]));

    expect(result).toBe(po);
    expect(innerItemRepo.save).not.toHaveBeenCalled();
    expect(innerPoRepo.save).not.toHaveBeenCalled();
  });

  it('rejects a new receipt against an already completed PO and rolls its provisional movement back', async () => {
    loadPo(
      makePo([makeItem({ quantityReceived: 100, isFullyReceived: true })], {
        status: PurchaseOrderStatus.RECEIVED,
      }),
    );

    await expect(
      handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 1 }])),
    ).rejects.toThrow('accepts only exact receipt replay');
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('locks PO state in-transaction and visits receipt items in canonical stock-lock order', async () => {
    const itemA = makeItem({ id: 'poi-a', itemId: ITEM_A, itemName: 'A' });
    const itemB = makeItem({ id: 'poi-b', itemId: ITEM_B, itemName: 'B' });
    loadPo(makePo([itemB, itemA]));

    await handler.execute(
      makeCommand([
        { itemId: ITEM_B, quantityReceived: 2 },
        { itemId: ITEM_A, quantityReceived: 1 },
      ]),
    );

    expect(innerPoRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(innerItemRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { itemId: 'ASC', id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(stockMovementService.recordMovement.mock.calls.map(([, input]) => input.itemId)).toEqual(
      [ITEM_A, ITEM_B],
    );
  });

  it('never writes StorageInventory or StockMovement rows directly (movement sink owns them)', async () => {
    loadPo(makePo([makeItem()]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    const requested = mockManager.getRepository.mock.calls.map((c) => c[0]);
    const names = requested.map((e) => (typeof e === 'function' ? e.name : String(e)));
    expect(names).not.toContain('StorageInventory');
    expect(names).not.toContain('StockMovement');
  });
});
