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
import type { OutboxPublisher } from '@platform/outbox';
import type { Repository } from 'typeorm';
import { BatchLifecyclePolicyService } from '../../services/batch-lifecycle-policy.service';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';

describe('UpdateBatchStatusHandler', () => {
  let handler: UpdateBatchStatusHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  // tenantManagerRepo(queryRunner.manager, Batch, tenantId) resolves the
  // manager-scoped Batch repository, then wraps it with tenant enforcement.
  const innerBatchRepo: Pick<Repository<Batch>, 'findOne' | 'create' | 'save'> = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((data: unknown) => data),
    save: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
  };

  const mockOutboxPublisher: Pick<OutboxPublisher, 'enqueue'> = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const lifecyclePolicy = new BatchLifecyclePolicyService();

  beforeEach(() => {
    jest.clearAllMocks();
    innerBatchRepo.findOne = jest.fn().mockResolvedValue(null);
    innerBatchRepo.create = jest.fn().mockImplementation((data: unknown) => data);
    innerBatchRepo.save = jest.fn().mockImplementation((data: unknown) =>
      Promise.resolve(data),
    );
    mockManager.getRepository = jest.fn().mockReturnValue(innerBatchRepo) as typeof mockManager.getRepository;
    mockOutboxPublisher.enqueue = jest.fn().mockResolvedValue(undefined);
    handler = new UpdateBatchStatusHandler(
      new RecordingBatchAggregateMutationPort(mockManager),
      mockDataSource,
      mockOutboxPublisher as OutboxPublisher,
      lifecyclePolicy,
    );
  });

  const TENANT = '11111111-1111-4111-8111-111111111111';
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
    innerBatchRepo.findOne = jest.fn().mockResolvedValueOnce(batch);
    innerBatchRepo.save = jest.fn().mockImplementation((data: unknown) =>
      Promise.resolve(data),
    );

    const result = await handler.execute(
      new UpdateBatchStatusCommand(TENANT, 'batch-1', BatchStatus.ACTIVE, undefined, USER),
    );

    expect(result.status).toBe(BatchStatus.ACTIVE);
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BatchStatusChanged',
        tenantId: TENANT,
        batchId: 'batch-1',
        previousStatus: BatchStatus.QUARANTINE,
        newStatus: BatchStatus.ACTIVE,
        userId: USER,
      }),
      mockManager,
    );
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should reject invalid transition ACTIVE → HARVESTED', async () => {
    const batch = makeBatch(BatchStatus.ACTIVE);
    innerBatchRepo.findOne = jest.fn().mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new UpdateBatchStatusCommand(TENANT, 'batch-1', BatchStatus.HARVESTED, undefined, USER)),
    ).rejects.toThrow(BadRequestException);

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('should throw NotFoundException when batch not found', async () => {
    innerBatchRepo.findOne = jest.fn().mockResolvedValueOnce(null);

    await expect(
      handler.execute(new UpdateBatchStatusCommand(TENANT, 'nonexistent', BatchStatus.ACTIVE, undefined, USER)),
    ).rejects.toThrow(NotFoundException);
  });

  it('should always release queryRunner even on error', async () => {
    innerBatchRepo.findOne = jest.fn().mockRejectedValueOnce(new Error('DB error'));

    await expect(
      handler.execute(new UpdateBatchStatusCommand(TENANT, 'batch-1', BatchStatus.ACTIVE, undefined, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
