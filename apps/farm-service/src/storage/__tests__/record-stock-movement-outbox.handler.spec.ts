import { RecordStockMovementHandler } from '../handlers/record-stock-movement.handler';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

/**
 * Outbox emission for stock movements (ORPHAN-MEDIUM-266). The handler must
 * enqueue its domain events to the transactional outbox INSIDE the movement
 * transaction (at-least-once), not fire a post-commit eventBus.publish
 * (at-most-once, drops the LowStockDetected reorder alert on a NATS outage).
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
    dataSource = { transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)) };
    handler = new RecordStockMovementHandler(
      dataSource as never,
      stockMovementService as never,
      outboxPublisher as never,
    );
  });

  it('enqueues StockMovementRecorded to the outbox with the transaction manager', async () => {
    stockMovementService.recordMovement.mockResolvedValue({ saved, currentTotal: 50, idempotentHit: false, warnings: [] });

    await handler.execute(command());

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(outboxPublisher.enqueue).toHaveBeenCalled();
    const [event, passedManager] = outboxPublisher.enqueue.mock.calls[0];
    expect(event.eventType).toBe('StockMovementRecorded');
    expect(passedManager).toBe(manager); // enqueued inside the same transaction
  });

  it('does NOT enqueue on idempotent replay (events already enqueued by the original)', async () => {
    stockMovementService.recordMovement.mockResolvedValue({ saved, currentTotal: 0, idempotentHit: true, warnings: [] });

    await handler.execute(command());

    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('also enqueues LowStockDetected when an OUT movement crosses the feed threshold', async () => {
    manager.findOne.mockResolvedValue({ id: 'feed1', minStock: 20 }); // currentTotal 5 <= 20 → low_stock
    stockMovementService.recordMovement.mockResolvedValue({ saved, currentTotal: 5, idempotentHit: false, warnings: [] });

    await handler.execute(command());

    const eventTypes = outboxPublisher.enqueue.mock.calls.map((c) => c[0].eventType);
    expect(eventTypes).toContain('StockMovementRecorded');
    expect(eventTypes).toContain('LowStockDetected');
  });

  it('never falls back to a direct eventBus publish (no eventBus dependency)', async () => {
    stockMovementService.recordMovement.mockResolvedValue({ saved, currentTotal: 50, idempotentHit: false, warnings: [] });
    // Constructed with only (dataSource, stockMovementService, outboxPublisher) — no eventBus.
    await expect(handler.execute(command())).resolves.toBeDefined();
  });
});
