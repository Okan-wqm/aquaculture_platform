/**
 * CloseBatchHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage -- batch closure with reason validation.
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
  // By default the harvest-eligibility service reports no blocking
  // events — the main positive paths cover the happy case. Tests that
  // exercise the compliance gate override this.
  const mockHarvestEligibility = {
    checkEligibility: jest
      .fn()
      .mockResolvedValue({ eligible: true, blockingEvents: [] }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockHarvestEligibility.checkEligibility.mockResolvedValue({
      eligible: true,
      blockingEvents: [],
    });
    handler = new CloseBatchHandler(
      {} as any, // dataSource
      mockBatchRepo as any,
      mockEventPublisher as any,
      mockHarvestEligibility as any,
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
      new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.HARVEST_COMPLETED, closedBy: USER }),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });

  it('should reject closing an already closed batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.CLOSED } as Batch;
    mockBatchRepo.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.OTHER, closedBy: USER })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject HARVEST_COMPLETED for a GROWING batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING } as Batch;
    mockBatchRepo.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.HARVEST_COMPLETED, closedBy: USER })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw NotFoundException for missing batch', async () => {
    mockBatchRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'nonexistent', reason: BatchCloseReason.OTHER, closedBy: USER })),
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
      new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.FAILED, closedBy: USER }),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });

  it('should reject OTHER reason for ACTIVE batch (restricted to terminal statuses)', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.ACTIVE } as Batch;
    mockBatchRepo.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.OTHER, closedBy: USER })),
    ).rejects.toThrow(BadRequestException);
  });
});
