/**
 * CloseBatchHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — batch closure with reason validation.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CloseBatchHandler } from '../../handlers/close-batch.handler';
import { CloseBatchCommand, BatchCloseReason } from '../../commands/close-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { createMockRepository } from '@aquaculture/testing';

describe('CloseBatchHandler', () => {
  let handler: CloseBatchHandler;
  const mockBatchRepo = createMockRepository<Batch>();
  const mockEventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new CloseBatchHandler(
      {} as any, // dataSource
      mockBatchRepo as any,
      mockEventPublisher as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  it('should close a HARVESTED batch with HARVEST_COMPLETED reason', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, status: BatchStatus.HARVESTED,
      isActive: true, notes: '',
    } as Batch;

    mockBatchRepo.findOne.mockResolvedValueOnce(batch);
    mockBatchRepo.save.mockResolvedValueOnce({ ...batch, status: BatchStatus.CLOSED });

    const result = await handler.execute(
      new CloseBatchCommand(TENANT, 'batch-1', BatchCloseReason.HARVEST_COMPLETED, USER),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });

  it('should reject closing an already closed batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.CLOSED } as Batch;
    mockBatchRepo.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand(TENANT, 'batch-1', BatchCloseReason.OTHER, USER)),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject HARVEST_COMPLETED for a GROWING batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING } as Batch;
    mockBatchRepo.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand(TENANT, 'batch-1', BatchCloseReason.HARVEST_COMPLETED, USER)),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw NotFoundException for missing batch', async () => {
    mockBatchRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new CloseBatchCommand(TENANT, 'nonexistent', BatchCloseReason.OTHER, USER)),
    ).rejects.toThrow(NotFoundException);
  });

  it('should allow FAILED reason for ACTIVE batch', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, status: BatchStatus.ACTIVE,
      isActive: true, notes: '',
    } as Batch;

    mockBatchRepo.findOne.mockResolvedValueOnce(batch);
    mockBatchRepo.save.mockResolvedValueOnce({ ...batch, status: BatchStatus.CLOSED });

    const result = await handler.execute(
      new CloseBatchCommand(TENANT, 'batch-1', BatchCloseReason.FAILED, USER),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });
});
