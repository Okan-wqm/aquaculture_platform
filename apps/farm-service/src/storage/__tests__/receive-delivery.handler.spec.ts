/**
 * ReceiveDeliveryHandler unit tests (P-08 / stock SSoT Phase 0).
 *
 * The handler previously wrote `storage_inventory` + `stock_movements` rows
 * DIRECTLY, bypassing `StockMovementService.recordMovement` — so a PO receipt
 * never rolled up onto `Feed.quantity` (invisible to the consumption
 * forecast), carried no idempotency key, and emitted no outbox event. These
 * tests pin the corrected contract:
 *   - every received item flows through recordMovement (IN) on the SAME
 *     transaction manager (roll-up + lot-mix + audit row live there);
 *   - the idempotency key is deterministic per (poItem, cumulative received);
 *   - StockMovementRecorded is enqueued to the transactional outbox inside
 *     the same transaction, and NOT re-enqueued on an idempotent replay;
 *   - an idempotent replay also skips the PO-item progress mutation;
 *   - over-receive still rejects; PO status transitions unchanged;
 *   - SEC-HIGH-051 site-authorization context reaches the movement sink;
 *   - the handler no longer touches StorageInventory/StockMovement repos.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';

type TransactionIsolationLevel = Parameters<DataSource['transaction']>[0];

import { ReceiveDeliveryHandler } from '../handlers/receive-delivery.handler';
import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import { PurchaseOrder, PurchaseOrderStatus, PurchaseOrderCategory } from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { MovementType } from '../entities/stock-movement.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const PO_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_A = '55555555-5555-4555-8555-555555555555';

describe('ReceiveDeliveryHandler', () => {
  let handler: ReceiveDeliveryHandler;
  let poRepository: jest.Mocked<Repository<PurchaseOrder>>;
  let innerPoRepo: jest.Mocked<Repository<PurchaseOrder>>;
  let innerItemRepo: jest.Mocked<Repository<PurchaseOrderItem>>;
  let stockMovementService: { recordMovement: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };
  const { mockDataSource, mockManager } = createMockDataSource();

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

  const makePo = (items: PurchaseOrderItem[], overrides: Partial<PurchaseOrder> = {}): PurchaseOrder =>
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
    items: Array<{ itemId: string; quantityReceived: number; lotNumber?: string; expiryDate?: string }>,
  ): ReceiveDeliveryCommand =>
    new ReceiveDeliveryCommand(
      { purchaseOrderId: PO_ID, storageLocationId: LOCATION, items },
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

  beforeEach(() => {
    jest.clearAllMocks();
    poRepository = createMockRepository<PurchaseOrder>();
    innerPoRepo = createMockRepository<PurchaseOrder>();
    innerItemRepo = createMockRepository<PurchaseOrderItem>();
    innerPoRepo.create.mockImplementation((data: unknown) => data as PurchaseOrder);
    innerPoRepo.save.mockImplementation((data: unknown) => Promise.resolve(data as PurchaseOrder));
    innerItemRepo.create.mockImplementation((data: unknown) => data as PurchaseOrderItem);
    innerItemRepo.save.mockImplementation((data: unknown) => Promise.resolve(data as PurchaseOrderItem));

    mockManager.getRepository.mockImplementation(((entity: unknown) =>
      entity === PurchaseOrderItem ? innerItemRepo : innerPoRepo) as never);

    mockDataSource.transaction = jest.fn();
    mockDataSource.transaction.mockImplementation(
      (
        isolationOrRun: TransactionIsolationLevel | ((m: EntityManager) => Promise<unknown>),
        runInTransaction: (m: EntityManager) => Promise<unknown>,
      ) => {
        const run = typeof isolationOrRun === 'function' ? isolationOrRun : runInTransaction;
        return run(mockManager);
      },
    );

    stockMovementService = { recordMovement: jest.fn().mockResolvedValue(movementResult()) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    handler = new ReceiveDeliveryHandler(
      poRepository as never,
      mockDataSource as never,
      stockMovementService as never,
      outboxPublisher as never,
    );
  });

  it('routes every received item through StockMovementService.recordMovement (IN) on the tx manager', async () => {
    const po = makePo([makeItem()]);
    poRepository.findOne.mockResolvedValue(po);

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40, lotNumber: 'LOT-9', expiryDate: '2027-01-01' }]));

    expect(stockMovementService.recordMovement).toHaveBeenCalledTimes(1);
    const [passedManager, input, ctx] = stockMovementService.recordMovement.mock.calls[0];
    expect(passedManager).toBe(mockManager);
    expect(input).toMatchObject({
      movementType: MovementType.IN,
      itemType: StorageItemType.FEED,
      itemId: ITEM_A,
      quantity: 40,
      toLocationId: LOCATION,
      lotNumber: 'LOT-9',
      reference: 'PO: PO-0007',
      idempotencyKey: 'po-receive-poi-1-40',
    });
    expect(input.expiryDate).toBeInstanceOf(Date);
    expect(ctx).toMatchObject({ tenantId: TENANT, userId: USER });
  });

  it('passes SEC-HIGH-051 site-authorization context to the movement sink', async () => {
    poRepository.findOne.mockResolvedValue(makePo([makeItem()]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 10 }]));

    const [, , ctx] = stockMovementService.recordMovement.mock.calls[0];
    expect(ctx.siteAuthorization).toEqual({
      sub: USER,
      roles: [Role.MODULE_MANAGER],
      assignedSiteIds: ['site-1'],
    });
  });

  it('enqueues StockMovementRecorded to the outbox inside the same transaction', async () => {
    poRepository.findOne.mockResolvedValue(makePo([makeItem()]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    const [event, passedManager] = outboxPublisher.enqueue.mock.calls[0];
    expect(event.eventType).toBe('StockMovementRecorded');
    expect(event.movementId).toBe('mov-1');
    expect(passedManager).toBe(mockManager);
  });

  it('derives the cumulative idempotency key across successive partial receipts', async () => {
    const item = makeItem({ quantityReceived: 40 });
    poRepository.findOne.mockResolvedValue(makePo([item]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 25 }]));

    const [, input] = stockMovementService.recordMovement.mock.calls[0];
    expect(input.idempotencyKey).toBe('po-receive-poi-1-65');
  });

  it('on idempotent replay: skips the outbox enqueue AND the PO-item progress mutation', async () => {
    const item = makeItem();
    poRepository.findOne.mockResolvedValue(makePo([item]));
    stockMovementService.recordMovement.mockResolvedValue(movementResult({ idempotentHit: true }));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(innerItemRepo.save).not.toHaveBeenCalled();
    expect(item.quantityReceived).toBe(0);
  });

  it('rejects over-receive with BadRequestException before any movement', async () => {
    poRepository.findOne.mockResolvedValue(makePo([makeItem({ quantity: 100, quantityReceived: 90 })]));

    await expect(
      handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 20 }])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stockMovementService.recordMovement).not.toHaveBeenCalled();
  });

  it('rejects a PO that is not in a receivable status', async () => {
    poRepository.findOne.mockResolvedValue(makePo([makeItem()], { status: PurchaseOrderStatus.DRAFT }));

    await expect(handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 1 }]))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unknown purchase order', async () => {
    poRepository.findOne.mockResolvedValue(null);

    await expect(handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 1 }]))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('propagates movement-sink failures so the whole receipt rolls back', async () => {
    poRepository.findOne.mockResolvedValue(makePo([makeItem()]));
    stockMovementService.recordMovement.mockRejectedValue(new NotFoundException('Storage location not found'));

    await expect(handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 5 }]))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('marks the PO RECEIVED with actualDeliveryDate when every item is fully received', async () => {
    const item = makeItem({ quantity: 100, quantityReceived: 60 });
    poRepository.findOne.mockResolvedValue(makePo([item]));

    const result = await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(item.quantityReceived).toBe(100);
    expect(item.isFullyReceived).toBe(true);
    expect(result.status).toBe(PurchaseOrderStatus.RECEIVED);
    expect(result.actualDeliveryDate).toBeInstanceOf(Date);
  });

  it('marks the PO PARTIALLY_RECEIVED when some quantity remains outstanding', async () => {
    const item = makeItem({ quantity: 100, quantityReceived: 0 });
    poRepository.findOne.mockResolvedValue(makePo([item]));

    const result = await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    expect(result.status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);
  });

  it('never writes StorageInventory or StockMovement rows directly (movement sink owns them)', async () => {
    poRepository.findOne.mockResolvedValue(makePo([makeItem()]));

    await handler.execute(makeCommand([{ itemId: ITEM_A, quantityReceived: 40 }]));

    const requested = mockManager.getRepository.mock.calls.map((c) => c[0]);
    const names = requested.map((e) => (typeof e === 'function' ? e.name : String(e)));
    expect(names).not.toContain('StorageInventory');
    expect(names).not.toContain('StockMovement');
  });
});
