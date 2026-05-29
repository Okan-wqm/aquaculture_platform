/**
 * UpdateBatchStatusHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — status FSM transitions.
 */
import { createMockDataSource } from '@aquaculture/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { Repository } from 'typeorm';

import { UpdateBatchStatusCommand } from '../../commands/update-batch-status.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { UpdateBatchStatusHandler } from '../../handlers/update-batch-status.handler';

describe('UpdateBatchStatusHandler', () => {
  let handler: UpdateBatchStatusHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  // Handler was migrated from DomainEventPublisher to OutboxPublisher
  // in phase D — the transactional outbox enqueues the event inside
  // the same tx as the domain write. Mock surfaces `enqueue(event,
  // manager)` and succeeds silently; assertions below verify the
  // event is emitted exactly once per status change.
  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as Pick<OutboxPublisher, 'enqueue'>;
  const mockBatchRepository = {} as Repository<Batch>;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new UpdateBatchStatusHandler(
      mockDataSource,
      mockBatchRepository,
      mockOutboxPublisher as unknown as OutboxPublisher,
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

  it('keeps actor and reason separate in the typed command payload', () => {
    const command = new UpdateBatchStatusCommand({
      tenantId: TENANT,
      batchId: 'batch-1',
      newStatus: BatchStatus.ACTIVE,
      updatedBy: USER,
      reason: 'quarantine complete',
    });

    expect(command.updatedBy).toBe(USER);
    expect(command.reason).toBe('quarantine complete');
  });

  it('should transition QUARANTINE → ACTIVE', async () => {
    const batch = makeBatch(BatchStatus.QUARANTINE);
    mockManager.findOne.mockResolvedValueOnce(batch);
    mockManager.save.mockResolvedValueOnce({ ...batch, status: BatchStatus.ACTIVE });

    const result = await handler.execute(
      new UpdateBatchStatusCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        newStatus: BatchStatus.ACTIVE,
        updatedBy: USER,
      }),
    );

    expect(result.status).toBe(BatchStatus.ACTIVE);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should reject invalid transition ACTIVE → HARVESTED', async () => {
    const batch = makeBatch(BatchStatus.ACTIVE);
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(
        new UpdateBatchStatusCommand({
          tenantId: TENANT,
          batchId: 'batch-1',
          newStatus: BatchStatus.HARVESTED,
          updatedBy: USER,
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(
        new UpdateBatchStatusCommand({
          tenantId: TENANT,
          batchId: 'nonexistent',
          newStatus: BatchStatus.ACTIVE,
          updatedBy: USER,
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('should always release queryRunner even on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('DB error'));

    await expect(
      handler.execute(
        new UpdateBatchStatusCommand({
          tenantId: TENANT,
          batchId: 'batch-1',
          newStatus: BatchStatus.ACTIVE,
          updatedBy: USER,
        }),
      ),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
