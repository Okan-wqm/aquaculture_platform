/**
 * UpdateBatchStatusHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — status FSM transitions.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UpdateBatchStatusHandler } from '../../handlers/update-batch-status.handler';
import { UpdateBatchStatusCommand } from '../../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { createMockDataSource } from '@aquaculture/testing';

describe('UpdateBatchStatusHandler', () => {
  let handler: UpdateBatchStatusHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockEventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new UpdateBatchStatusHandler(
      mockDataSource as any,
      {} as any, // batchRepository (not used directly — handler uses queryRunner.manager)
      mockEventPublisher as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  function makeBatch(status: BatchStatus): Partial<Batch> {
    return {
      id: 'batch-1',
      tenantId: TENANT,
      status,
      isActive: true,
      canTransitionTo: Batch.prototype.canTransitionTo,
      statusChangedAt: new Date(),
    };
  }

  it('should transition QUARANTINE → ACTIVE', async () => {
    const batch = makeBatch(BatchStatus.QUARANTINE);
    mockManager.findOne.mockResolvedValueOnce(batch);
    mockManager.save.mockResolvedValueOnce({ ...batch, status: BatchStatus.ACTIVE });

    const result = await handler.execute(
      new UpdateBatchStatusCommand(TENANT, 'batch-1', BatchStatus.ACTIVE, USER),
    );

    expect(result.status).toBe(BatchStatus.ACTIVE);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should reject invalid transition ACTIVE → HARVESTED', async () => {
    const batch = makeBatch(BatchStatus.ACTIVE);
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new UpdateBatchStatusCommand(TENANT, 'batch-1', BatchStatus.HARVESTED, USER)),
    ).rejects.toThrow(BadRequestException);

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new UpdateBatchStatusCommand(TENANT, 'nonexistent', BatchStatus.ACTIVE, USER)),
    ).rejects.toThrow(NotFoundException);
  });

  it('should always release queryRunner even on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('DB error'));

    await expect(
      handler.execute(new UpdateBatchStatusCommand(TENANT, 'batch-1', BatchStatus.ACTIVE, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
