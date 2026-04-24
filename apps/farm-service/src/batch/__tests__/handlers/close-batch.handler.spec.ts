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
import {
  createMockDataSource,
  createMockRepository,
} from '@aquaculture/testing';

describe('CloseBatchHandler', () => {
  let handler: CloseBatchHandler;
  const mockBatchRepo = createMockRepository<Batch>();
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  // Handler migrated to OutboxPublisher (phase D) — events enqueue
  // on the outbox table inside the same tx as the domain write.
  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
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
      mockDataSource as any,
      mockBatchRepo as any,
      mockOutboxPublisher as any,
      mockHarvestEligibility as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';
  // Every CloseBatchOptions now requires userRoles. This suite's
  // scope is the status-FSM + NotFound invariants; the
  // BatchCloseReason.OTHER branch requires TENANT_ADMIN so the
  // default is set accordingly. Tests that exercise the
  // role-gating explicitly (e.g. OTHER reason from a non-admin
  // caller) would pass `[]` instead — not covered in this
  // repair slice.
  const ROLES: Role[] = [Role.TENANT_ADMIN];

  // Handler reads final biomass / avg weight / mortality via Batch
  // instance methods; the shape-only mocks below stub them so the
  // close-summary JSONB fields land without NaN.
  function makeClosedBatchMock(status: BatchStatus, id = 'batch-1') {
    return {
      id,
      tenantId: TENANT,
      status,
      isActive: true,
      notes: '',
      currentQuantity: 1000,
      totalMortality: 0,
      totalFeedConsumed: 0,
      fcr: { actual: 0 },
      getCurrentBiomass: () => 500,
      getCurrentAvgWeight: () => 500,
      getMortalityRate: () => 0,
      getSurvivalRate: () => 100,
      getRetentionRate: () => 100,
      getDaysInProduction: () => 30,
      // growthMetrics is a JSONB column; handler writes
      // `batch.growthMetrics.daysInProduction = ...` so the mock
      // needs a settable object for that assignment to land.
      growthMetrics: { daysInProduction: 0 },
    } as unknown as Batch;
  }

  it('should close a HARVESTED batch with HARVEST_COMPLETED reason', async () => {
    const batch = makeClosedBatchMock(BatchStatus.HARVESTED);

    mockManager.findOne.mockResolvedValueOnce(batch);
    mockManager.save.mockResolvedValueOnce({ ...batch, status: BatchStatus.CLOSED } as Batch);

    const result = await handler.execute(
      new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.HARVEST_COMPLETED, closedBy: USER, userRoles: ROLES }),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });

  it('should reject closing an already closed batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.CLOSED } as Batch;
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.OTHER, closedBy: USER, userRoles: ROLES })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject HARVEST_COMPLETED for a GROWING batch', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING } as Batch;
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.HARVEST_COMPLETED, closedBy: USER, userRoles: ROLES })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw NotFoundException for missing batch', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'nonexistent', reason: BatchCloseReason.OTHER, closedBy: USER, userRoles: ROLES })),
    ).rejects.toThrow(NotFoundException);
  });

  it('should allow FAILED reason for ACTIVE batch', async () => {
    const batch = makeClosedBatchMock(BatchStatus.ACTIVE);

    mockManager.findOne.mockResolvedValueOnce(batch);
    mockManager.save.mockResolvedValueOnce({ ...batch, status: BatchStatus.CLOSED } as Batch);

    const result = await handler.execute(
      new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.FAILED, closedBy: USER, userRoles: ROLES }),
    );

    expect(result.status).toBe(BatchStatus.CLOSED);
  });

  it('should reject OTHER reason for ACTIVE batch (restricted to terminal statuses)', async () => {
    const batch = { id: 'batch-1', tenantId: TENANT, status: BatchStatus.ACTIVE } as Batch;
    mockManager.findOne.mockResolvedValueOnce(batch);

    await expect(
      handler.execute(new CloseBatchCommand({ tenantId: TENANT, batchId: 'batch-1', reason: BatchCloseReason.OTHER, closedBy: USER, userRoles: ROLES })),
    ).rejects.toThrow(BadRequestException);
  });
});
