import { RecordStockMovementHandler } from '../handlers/record-stock-movement.handler';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { createMockDataSource } from '@aquaculture/testing';

/**
 * Outbox emission for stock movements (ORPHAN-MEDIUM-266 + stock SSoT
 * Phase 1). StockMovementService owns StockMovementRecorded and
 * LowStockDetected inside the movement transaction. The handler owns only the POST-COMMIT
 * in-process `inventory.lowStock` emit that feeds the STOCK_LOW auto-task
 * trigger — post-commit so a rolled-back movement can never spawn a task.
 */
describe('RecordStockMovementHandler — canonical authority adapter', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const itemId = '33333333-3333-4333-8333-333333333333';
  const saved = {
    id: 'm1',
    movementType: MovementType.OUT,
    itemType: StorageItemType.FEED,
    itemId,
    itemName: 'Feed A',
    quantity: 10,
    unit: 'kg',
    fromLocationId: 'loc1',
    toLocationId: null,
    lotNumber: 'L1',
  };

  let stockMovementService: { recordMovement: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let handler: RecordStockMovementHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  const command = (): RecordStockMovementCommand =>
    new RecordStockMovementCommand(
      {
        movementType: MovementType.OUT,
        itemType: StorageItemType.FEED,
        itemId,
        quantity: 10,
      } as never,
      tenantId,
      userId,
      'User',
      [],
      [],
    );

  beforeEach(() => {
    stockMovementService = { recordMovement: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    mockQueryRunner.query.mockResolvedValue([]);
    handler = new RecordStockMovementHandler(
      mockDataSource as never,
      stockMovementService as never,
      eventEmitter as never,
    );
  });

  it('delegates the complete mutation to the authority on an opaque tenant session', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved,
      currentTotal: 50,
      idempotentHit: false,
      warnings: [],
      lowStock: null,
    });

    await handler.execute(command());

    expect(mockDataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    const [session, input, context] = stockMovementService.recordMovement.mock.calls[0];
    expect(session).not.toBe(mockManager);
    expect(input).toEqual(expect.objectContaining({ movementType: MovementType.OUT, itemId }));
    expect(context).toEqual(expect.objectContaining({ tenantId, userId }));
  });

  it('does NOT enqueue on idempotent replay (events already enqueued by the original)', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved,
      currentTotal: 0,
      idempotentHit: true,
      warnings: [],
      lowStock: null,
    });

    await handler.execute(command());

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('emits the in-process inventory.lowStock signal POST-COMMIT when the sink flagged low stock', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved,
      currentTotal: 5,
      idempotentHit: false,
      warnings: [],
      lowStock: { severity: 'low_stock', minimumThreshold: 20 },
    });

    await handler.execute(command());

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [signal, payload] = eventEmitter.emit.mock.calls[0];
    expect(signal).toBe('inventory.lowStock');
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.lowStock).toEqual([
      {
        id: itemId,
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
      saved,
      currentTotal: 0,
      idempotentHit: false,
      warnings: [],
      lowStock: { severity: 'out_of_stock', minimumThreshold: 20 },
    });

    await handler.execute(command());

    const [, payload] = eventEmitter.emit.mock.calls[0];
    expect(payload.outOfStock).toHaveLength(1);
    expect(payload.lowStock).toEqual([]);
  });

  it('never falls back to a direct eventBus publish (no eventBus dependency)', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved,
      currentTotal: 50,
      idempotentHit: false,
      warnings: [],
      lowStock: null,
    });
    // Constructed with only (dataSource, stockMovementService, eventEmitter) — no eventBus.
    await expect(handler.execute(command())).resolves.toBeDefined();
  });
});
