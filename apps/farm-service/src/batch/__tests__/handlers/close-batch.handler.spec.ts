/**
 * CloseBatchHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage -- batch closure with reason validation.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import { CloseBatchHandler } from '../../handlers/close-batch.handler';
import { CloseBatchCommand, BatchCloseReason } from '../../commands/close-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common';

describe('CloseBatchHandler', () => {
  let handler: CloseBatchHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockBatchRepo = createMockRepository<Batch>();
  const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const mockHarvestEligibility = {
    checkEligibility: jest.fn().mockResolvedValue({
      eligible: true,
      blockingEvents: [],
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new CloseBatchHandler(
      mockDataSource as any,
      mockBatchRepo as any,
      mockOutboxPublisher as any,
      mockHarvestEligibility as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';
  const USER_ROLES: Role[] = [];

  const createClosableBatch = (status: BatchStatus): Batch => ({
    id: 'batch-1',
    tenantId: TENANT,
    status,
    isActive: true,
    notes: '',
    currentQuantity: 1000,
    totalMortality: 25,
    totalFeedConsumed: 125,
    fcr: { actual: 1.4 },
    sgr: 2.1,
    costPerKg: 4.8,
    growthMetrics: { daysInProduction: 0 },
    getCurrentBiomass: jest.fn().mockReturnValue(50),
    getCurrentAvgWeight: jest.fn().mockReturnValue(50),
    getMortalityRate: jest.fn().mockReturnValue(2.5),
    getSurvivalRate: jest.fn().mockReturnValue(97.5),
    getRetentionRate: jest.fn().mockReturnValue(97.5),
    getDaysInProduction: jest.fn().mockReturnValue(30),
  } as unknown as Batch);

  it('should close a HARVESTED batch with HARVEST_COMPLETED reason', async () => {
    const batch = createClosableBatch(BatchStatus.HARVESTED);

    mockManager.findOne.mockResolvedValueOnce(batch);

    const result = await handler.execute(
      new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        reason: BatchCloseReason.HARVEST_COMPLETED,
        closedBy: USER,
        userRoles: USER_ROLES,
      }),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalled();
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('should reject closing an already closed batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.CLOSED } as Batch;
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        reason: BatchCloseReason.OTHER,
        closedBy: USER,
        userRoles: USER_ROLES,
      })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject HARVEST_COMPLETED for a GROWING batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING } as Batch;
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        reason: BatchCloseReason.HARVEST_COMPLETED,
        closedBy: USER,
        userRoles: USER_ROLES,
      })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw NotFoundException for missing batch', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'nonexistent',
        reason: BatchCloseReason.OTHER,
        closedBy: USER,
        userRoles: USER_ROLES,
      })),
    ).rejects.toThrow(NotFoundException);
  });

  it('should allow FAILED reason for ACTIVE batch', async () => {
    const batch = createClosableBatch(BatchStatus.ACTIVE);

    mockManager.findOne.mockResolvedValueOnce(batch);

    const result = await handler.execute(
      new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        reason: BatchCloseReason.FAILED,
        closedBy: USER,
        userRoles: USER_ROLES,
      }),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });

  it('should reject OTHER reason for ACTIVE batch as non-admin override', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.ACTIVE } as Batch;
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        reason: BatchCloseReason.OTHER,
        closedBy: USER,
        userRoles: USER_ROLES,
      })),
    ).rejects.toThrow(ForbiddenException);
  });
});
