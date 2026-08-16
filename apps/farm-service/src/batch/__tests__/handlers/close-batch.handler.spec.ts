/**
 * CloseBatchHandler Unit Tests
 *
 * CQRS handler coverage — batch closure with reason validation, withdrawal
 * gate, and compute-at-close of the authoritative final FCR + biomass.
 *
 * The handler closes inside runInTenantTransaction (pessimistic_write lock),
 * so we exercise the real tenant transaction helper against a mocked
 * DataSource/QueryRunner. tenantId MUST be a valid UUID because
 * runInTenantTransaction pins the tenant search_path and rejects non-UUIDs.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import { createMockDataSource } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';
import type { Repository } from 'typeorm';

import { CloseBatchHandler } from '../../handlers/close-batch.handler';
import { CloseBatchCommand, BatchCloseReason } from '../../commands/close-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { BatchLifecyclePolicyService } from '../../services/batch-lifecycle-policy.service';
import type { BatchHarvestEligibilityService } from '../../../fish-health/services/batch-harvest-eligibility.service';
import type { FCRCalculationService } from '../../../growth/services/fcr-calculation.service';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';

describe('CloseBatchHandler', () => {
  let handler: CloseBatchHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  // tenantManagerRepo(queryRunner.manager, Batch) resolves the manager-scoped
  // Batch repository, wrapped by TenantScopedRepository. We control that inner
  // repo so findOne returns the locked batch and save echoes it back.
  const innerBatchRepo: Pick<Repository<Batch>, 'findOne' | 'create' | 'save'> = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((data: unknown) => data),
    save: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
  };

  const mockOutboxPublisher: Pick<OutboxPublisher, 'enqueue'> = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const mockHarvestEligibility: Pick<BatchHarvestEligibilityService, 'checkEligibility'> = {
    checkEligibility: jest.fn().mockResolvedValue({
      eligible: true,
      blockingEvents: [],
    }),
  };
  // Real BatchLifecyclePolicyService — pure policy logic, no DB. Using the real
  // instance keeps the close-reason assertions honest.
  const lifecyclePolicy = new BatchLifecyclePolicyService();
  const mockFcrCalculation: Pick<FCRCalculationService, 'calculateCumulativeFCR'> = {
    calculateCumulativeFCR: jest.fn().mockResolvedValue({
      fcr: 1.62,
      totalFeed: 125,
      totalGrowth: 77,
      removedBiomassKg: 12,
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    innerBatchRepo.findOne = jest.fn().mockResolvedValue(null);
    innerBatchRepo.create = jest.fn().mockImplementation((data: unknown) => data);
    innerBatchRepo.save = jest.fn().mockImplementation((data: unknown) => Promise.resolve(data));
    // Route the manager-scoped Batch repository to the controllable repo.
    mockManager.getRepository = jest.fn().mockReturnValue(innerBatchRepo) as typeof mockManager.getRepository;
    mockHarvestEligibility.checkEligibility = jest.fn().mockResolvedValue({
      eligible: true,
      blockingEvents: [],
    });
    mockFcrCalculation.calculateCumulativeFCR = jest.fn().mockResolvedValue({
      fcr: 1.62,
      totalFeed: 125,
      totalGrowth: 77,
      removedBiomassKg: 12,
    });
    mockOutboxPublisher.enqueue = jest.fn().mockResolvedValue(undefined);
    handler = new CloseBatchHandler(
      new RecordingBatchAggregateMutationPort(mockManager),
      mockDataSource,
      mockOutboxPublisher as OutboxPublisher,
      mockHarvestEligibility as BatchHarvestEligibilityService,
      lifecyclePolicy,
      mockFcrCalculation as FCRCalculationService,
    );
  });

  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = 'user-1';
  const USER_ROLES: Role[] = [];

  const createClosableBatch = (status: BatchStatus): Batch =>
    Object.assign(new Batch(), {
      id: 'batch-1',
      tenantId: TENANT,
      status,
      isActive: true,
      notes: '',
      initialQuantity: 1100,
      currentQuantity: 1000,
      totalMortality: 25,
      totalFeedConsumed: 125,
      sgr: 2.1,
      costPerKg: 4.8,
      stockedAt: new Date('2026-01-01T00:00:00.000Z'),
      fcr: {
        target: 1.4,
        actual: 0, // stale — proves the handler does NOT trust this on close
        theoretical: 1.4,
        isUserOverride: false,
        lastUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      growthMetrics: { daysInProduction: 0, growthRate: {}, projections: {} },
      weight: {
        initial: { avgWeight: 5, totalBiomass: 5.5, measuredAt: new Date() },
        theoretical: { avgWeight: 80, totalBiomass: 80, lastCalculatedAt: new Date(), basedOnFCR: 1.4 },
        actual: {
          avgWeight: 80,
          totalBiomass: 999, // stale snapshot — derive-on-read must override
          lastMeasuredAt: new Date(),
          sampleSize: 100,
          confidencePercent: 95,
        },
        variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
      },
    });

  it('should close a HARVESTED batch with HARVEST_COMPLETED reason', async () => {
    const batch = createClosableBatch(BatchStatus.HARVESTED);
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(batch);

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

  it('computes finalFCR from FcrCalculationService (not the stale batch.fcr) and persists it', async () => {
    const batch = createClosableBatch(BatchStatus.HARVESTED);
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(batch);

    const result = await handler.execute(
      new CloseBatchCommand({
        tenantId: TENANT,
        batchId: 'batch-1',
        reason: BatchCloseReason.HARVEST_COMPLETED,
        closedBy: USER,
        userRoles: USER_ROLES,
      }),
    );

    expect(mockFcrCalculation.calculateCumulativeFCR).toHaveBeenCalledWith('batch-1', TENANT);
    // Persisted onto the batch row in the same tx (was 0 before close).
    expect(result.fcr.actual).toBe(1.62);
    // Derive-on-read biomass freezes 1000 × 80 / 1000 = 80, NOT the stale 999.
    expect(result.weight.actual.totalBiomass).toBe(80);

    // Frozen into the BatchClosed event.
    const enqueued = (mockOutboxPublisher.enqueue as jest.Mock).mock.calls[0][0];
    expect(enqueued.finalFCR).toBe(1.62);
    expect(enqueued.finalBiomassKg).toBe(80);
    expect(enqueued.finalQuantity).toBe(1000);
  });

  it('should reject closing an already closed batch', async () => {
    const batch = Object.assign(new Batch(), {
      id: 'batch-1',
      tenantId: TENANT,
      status: BatchStatus.CLOSED,
    });
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(batch);

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
    const batch = createClosableBatch(BatchStatus.GROWING);
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(batch);

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
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

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
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(batch);

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
    const batch = createClosableBatch(BatchStatus.ACTIVE);
    (innerBatchRepo.findOne as jest.Mock).mockResolvedValueOnce(batch);

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
