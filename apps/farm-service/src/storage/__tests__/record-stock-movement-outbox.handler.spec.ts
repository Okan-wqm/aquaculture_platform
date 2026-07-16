import { RecordStockMovementHandler } from '../handlers/record-stock-movement.handler';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

/**
 * Outbox emission for stock movements (ORPHAN-MEDIUM-266 + stock SSoT
 * Phase 1). The handler enqueues StockMovementRecorded to the transactional
 * outbox INSIDE the movement transaction (at-least-once). LowStockDetected
 * is NOT this wrapper's job anymore — the single low-stock sink lives inside
 * StockMovementService.recordMovement so feeding deductions and PO receipts
 * emit the same signal (FARM-HIGH-217). What remains here is the POST-COMMIT
 * in-process `inventory.lowStock` emit that feeds the STOCK_LOW auto-task
 * trigger — post-commit so a rolled-back movement can never spawn a task.
 */
describe('RecordStockMovementHandler — transactional outbox emission', () => {
  const tenantId = 't1';
  const userId = 'u1';
  const saved = {
    id: 'm1',
    movementType: MovementType.OUT,
    itemType: StorageItemType.FEED,
    itemId: 'feed1',
    itemName: 'Feed A',
    quantity: 10,
    unit: 'kg',
    fromLocationId: 'loc1',
    toLocationId: null,
    lotNumber: 'L1',
  };

  let manager: { findOne: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };
  let stockMovementService: { recordMovement: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let handler: RecordStockMovementHandler;

  const command = (): RecordStockMovementCommand =>
    new RecordStockMovementCommand(
      { movementType: MovementType.OUT, itemType: StorageItemType.FEED, itemId: 'feed1', quantity: 10 } as never,
      tenantId,
      userId,
      'User',
      [],
      [],
    );

  beforeEach(() => {
    manager = { findOne: jest.fn().mockResolvedValue(null) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    stockMovementService = { recordMovement: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    dataSource = { transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)) };
    handler = new RecordStockMovementHandler(
      dataSource as never,
      stockMovementService as never,
      outboxPublisher as never,
      eventEmitter as never,
    );
  });

  it('enqueues StockMovementRecorded to the outbox with the transaction manager', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved, currentTotal: 50, idempotentHit: false, warnings: [], lowStock: null,
    });

    await handler.execute(command());

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    const [event, passedManager] = outboxPublisher.enqueue.mock.calls[0];
    expect(event.eventType).toBe('StockMovementRecorded');
    expect(passedManager).toBe(manager); // enqueued inside the same transaction
  });

  it('does NOT enqueue on idempotent replay (events already enqueued by the original)', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved, currentTotal: 0, idempotentHit: true, warnings: [], lowStock: null,
    });

    await handler.execute(command());

    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does NOT enqueue LowStockDetected itself — the sink inside recordMovement owns it', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved, currentTotal: 5, idempotentHit: false, warnings: [],
      lowStock: { severity: 'low_stock', minimumThreshold: 20 },
    });

    await handler.execute(command());

    const eventTypes = outboxPublisher.enqueue.mock.calls.map((c) => c[0].eventType);
    expect(eventTypes).toEqual(['StockMovementRecorded']);
  });

  it('emits the in-process inventory.lowStock signal POST-COMMIT when the sink flagged low stock', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved, currentTotal: 5, idempotentHit: false, warnings: [],
      lowStock: { severity: 'low_stock', minimumThreshold: 20 },
    });

    await handler.execute(command());

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [signal, payload] = eventEmitter.emit.mock.calls[0];
    expect(signal).toBe('inventory.lowStock');
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.lowStock).toEqual([
      {
        id: 'feed1',
        name: 'Feed A',
        itemType: StorageItemType.FEED,
        currentQuantity: 5,
        minimumThreshold: 20,
      },
    ]);
    expect(payload.outOfStock).toEqual([]);
  });

  it('routes an out_of_stock result into the outOfStock bucket of the in-process signal', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved, currentTotal: 0, idempotentHit: false, warnings: [],
      lowStock: { severity: 'out_of_stock', minimumThreshold: 20 },
    });

    await handler.execute(command());

    const [, payload] = eventEmitter.emit.mock.calls[0];
    expect(payload.outOfStock).toHaveLength(1);
    expect(payload.lowStock).toEqual([]);
  });

  it('never falls back to a direct eventBus publish (no eventBus dependency)', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved, currentTotal: 50, idempotentHit: false, warnings: [], lowStock: null,
    });
    // Constructed with only (dataSource, stockMovementService, outboxPublisher,
    // eventEmitter) — no eventBus.
    await expect(handler.execute(command())).resolves.toBeDefined();
  });
});
