import { RecordStockMovementHandler } from '../handlers/record-stock-movement.handler';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

/** The handler is now only a tenant-transaction adapter around the single sink. */
describe('RecordStockMovementHandler — canonical mutation adapter', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const saved = {
    id: 'm1',
    movementType: MovementType.OUT,
    itemType: StorageItemType.FEED,
    itemId: '33333333-3333-4333-8333-333333333333',
    itemName: 'Feed A',
    quantity: 10,
    unit: 'kg',
    fromLocationId: '44444444-4444-4444-8444-444444444444',
    lotNumber: 'L1',
  };

  let manager: object;
  let stockMovementService: { recordMovement: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let commit: jest.Mock;
  let rollback: jest.Mock;
  let handler: RecordStockMovementHandler;

  const command = (): RecordStockMovementCommand =>
    new RecordStockMovementCommand(
      {
        movementType: MovementType.OUT,
        itemType: StorageItemType.FEED,
        itemId: saved.itemId,
        quantity: 10,
      } as never,
      tenantId,
      userId,
      'User',
      [],
      [],
    );

  beforeEach(() => {
    manager = {};
    stockMovementService = { recordMovement: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    commit = jest.fn().mockResolvedValue(undefined);
    rollback = jest.fn().mockResolvedValue(undefined);
    const queryRunner = {
      manager,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: commit,
      rollbackTransaction: rollback,
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    };
    const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
    handler = new RecordStockMovementHandler(
      dataSource as never,
      stockMovementService as never,
      eventEmitter as never,
    );
  });

  it('delegates to the sole sink on the tenant transaction manager', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved,
      currentTotal: 50,
      idempotentHit: false,
      warnings: [],
      lowStock: null,
    });

    await handler.execute(command());

    expect(stockMovementService.recordMovement).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ movementType: MovementType.OUT, itemId: saved.itemId }),
      expect.objectContaining({ tenantId, userId }),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not emit an in-process signal on idempotent replay', async () => {
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

  it('emits inventory.lowStock only after the transaction commits', async () => {
    stockMovementService.recordMovement.mockResolvedValue({
      saved,
      currentTotal: 5,
      idempotentHit: false,
      warnings: [],
      lowStock: { severity: 'low_stock', minimumThreshold: 20 },
    });

    await handler.execute(command());

    expect(commit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'inventory.lowStock',
      expect.objectContaining({
        tenantId,
        lowStock: [expect.objectContaining({ id: saved.itemId, currentQuantity: 5 })],
      }),
    );
  });
});
