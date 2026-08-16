import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import {
  RecordingBatchAggregateMutationPort,
  RecordingFeedingAggregateMutationPort,
} from '../../../__tests__/support/durable-mutation-test-authority';
import { Batch } from '../../../batch/entities/batch.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { FeedingDayPlan } from '../../../feeding-protocol/entities/feeding-day-plan.entity';
import type { FeedingOperationSession } from '../../../feeding-protocol/feeding-operation-session';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import type { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { UpdateFeedingRecordOperationExecutor } from '../../executors/update-feeding-record-operation.executor';
import { FeedingMethod, FeedingRecord } from '../../entities/feeding-record.entity';
import type { FeedingStorageCorrectionService } from '../../services/feeding-storage-correction.service';
import type { OutboxPublisher } from '@platform/outbox';
import { feedingProtocolTestMutationInstant } from '../../../__tests__/support/feeding-protocol-test-authority';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OPERATION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION = Object.freeze({}) as FeedingOperationSession;
const MUTATION_SESSION = Object.freeze({}) as TenantMutationSession;
const MUTATION_INSTANT = feedingProtocolTestMutationInstant('2026-08-08T12:00:00.000Z');

let sessionManager: EntityManager;

jest.mock('../../../feeding-protocol/feeding-operation-session', () => ({
  feedingOperationObservedAt: jest.fn(() => new Date('2026-08-08T12:00:00.000Z')),
  readFeedingOperationSession: jest.fn(() => ({
    manager: sessionManager,
    mutationSession: MUTATION_SESSION,
    mutationInstant: MUTATION_INSTANT,
    tenantId: TENANT,
    operationId: OPERATION_ID,
    generation: 1,
    attempt: 1,
    localDate: '2026-08-08',
    timezone: 'UTC',
    siteId: SITE_ID,
    unitId: UNIT_ID,
  })),
}));

function mock<T>(value: Partial<T>): T {
  return value as T;
}

function record(overrides: Partial<FeedingRecord> = {}): FeedingRecord {
  const occurredAt = new Date('2026-08-08T08:00:00.000Z');
  return mock<FeedingRecord>({
    id: 'record-1',
    tenantId: TENANT,
    batchId: BATCH_ID,
    tankId: UNIT_ID,
    dayPlanId: 'plan-1',
    feedingDate: occurredAt,
    feedingTime: '08:00',
    feedingSequence: 1,
    totalMealsToday: 1,
    feedId: 'feed-1',
    plannedAmount: 10,
    actualAmount: 10,
    variance: 0,
    variancePercent: 0,
    feedCost: 100,
    feedCostDecimal: 100,
    currency: 'NOK',
    feedingMethod: FeedingMethod.MANUAL,
    fedBy: USER_ID,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    calculateVariance: jest.fn(),
    ...overrides,
  });
}

interface HarnessOptions {
  readonly feedingRecord?: FeedingRecord | null;
  readonly outboxFailure?: Error;
}

function harness(options: HarnessOptions = {}) {
  const feedingRecord = options.feedingRecord === undefined ? record() : options.feedingRecord;
  const batch = mock<Batch>({
    id: BATCH_ID,
    tenantId: TENANT,
    totalFeedConsumed: 500,
    totalFeedCost: 5000,
  });
  const dayPlan = mock<FeedingDayPlan>({
    id: 'plan-1',
    tenantId: TENANT,
    unitId: UNIT_ID,
    siteId: SITE_ID,
    resolution: mock<FeedingDayPlan['resolution']>({ expectedFcr: 1.25 }),
    snapshot: mock<FeedingDayPlan['snapshot']>({ expectedFcr: 1.25 }),
  });
  const tankBatch = mock<TankBatch>({
    id: 'tank-batch-1',
    tenantId: TENANT,
    tankId: UNIT_ID,
    primaryBatchId: BATCH_ID,
    primaryBatchNumber: 'BATCH-1',
    totalQuantity: 1000,
    totalBiomassKg: 100,
    currentBiomassKg: 100,
    avgWeightG: 100,
    batchDetails: [
      {
        batchId: BATCH_ID,
        batchNumber: 'BATCH-1',
        quantity: 1000,
        avgWeightG: 100,
        biomassKg: 100,
        percentageOfTank: 100,
      },
    ],
  });
  const managerDataSource = new DataSource({ type: 'postgres', database: 'feeding-update-test' });
  sessionManager = managerDataSource.manager;
  const findOne = jest.spyOn(sessionManager, 'findOne');
  jest.spyOn(sessionManager, 'find').mockResolvedValue([batch]);
  jest.spyOn(sessionManager, 'query').mockResolvedValue([{ biomass: 104, quantity: 1000 }]);

  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const applyStorageCorrection = jest.fn().mockResolvedValue(undefined);
  const enqueue = jest.fn(async () => {
    if (options.outboxFailure) throw options.outboxFailure;
  });
  const feedingMutations = new RecordingFeedingAggregateMutationPort();
  const batchMutations = new RecordingBatchAggregateMutationPort();
  const growthApplier = new BiomassGrowthApplierService(batchMutations);
  const withUnitGrowthMutation = jest.spyOn(growthApplier, 'withUnitGrowthMutation');
  const executor = new UpdateFeedingRecordOperationExecutor(
    feedingMutations,
    batchMutations,
    growthApplier,
    mock<DayPlanRecalcService>({ recalcForUnit }),
    mock<FeedingStorageCorrectionService>({ apply: applyStorageCorrection }),
    mock<OutboxPublisher>({ enqueue }),
  );

  const execute = (payload: { actualAmount?: number; notes?: string }) => {
    findOne.mockReset();
    findOne.mockResolvedValueOnce(feedingRecord);
    if (payload.actualAmount !== undefined && feedingRecord?.mealId == null) {
      findOne
        .mockResolvedValueOnce(tankBatch)
        .mockResolvedValueOnce(tankBatch)
        .mockResolvedValueOnce(dayPlan)
        .mockResolvedValueOnce(feedingRecord)
        .mockResolvedValueOnce(null);
    } else if (feedingRecord?.mealId == null) {
      findOne.mockResolvedValueOnce(feedingRecord);
    }
    return executor.executeUpdateFeedingRecordOperation(SESSION, {
      jobId: 'manual.feeding.update',
      tenantId: TENANT,
      actorId: USER_ID,
      requestId: OPERATION_ID,
      feedingRecordId: 'record-1',
      payload,
    });
  };

  return {
    execute,
    feedingRecord,
    batch,
    feedingMutations,
    batchMutations,
    tankBatch,
    withUnitGrowthMutation,
    recalcForUnit,
    applyStorageCorrection,
    enqueue,
  };
}

describe('UpdateFeedingRecordOperationExecutor', () => {
  it('applies amount, cost, plan, storage and growth corrections under one operation session', async () => {
    const h = harness();

    const result = await h.execute({ actualAmount: 15 });

    expect(h.feedingMutations.commitFeedingRecordTransition).toHaveBeenCalledWith(
      MUTATION_SESSION,
      expect.objectContaining({ intent: 'corrected', aggregate: h.feedingRecord }),
    );
    expect(h.batchMutations.commitBatchTransition).toHaveBeenCalledWith(
      MUTATION_SESSION,
      expect.objectContaining({ intent: 'feeding_corrected', aggregate: h.batch }),
    );
    expect(h.feedingMutations.incrementDayPlanUnplannedActual).toHaveBeenCalledWith(
      MUTATION_SESSION,
      { dayPlanId: 'plan-1', deltaKg: 5 },
    );
    expect(h.applyStorageCorrection).toHaveBeenCalledWith(
      MUTATION_SESSION,
      expect.objectContaining({ deltaKg: 5, feedId: 'feed-1', siteId: SITE_ID }),
    );
    expect(h.withUnitGrowthMutation).toHaveBeenCalledWith(
      sessionManager,
      MUTATION_SESSION,
      TENANT,
      UNIT_ID,
      MUTATION_INSTANT,
      expect.any(Function),
    );
    expect(h.batchMutations.commitTankBatchTransition).toHaveBeenCalledWith(
      MUTATION_SESSION,
      expect.objectContaining({ intent: 'feeding_growth_applied', aggregate: h.tankBatch }),
    );
    expect(h.tankBatch.totalBiomassKg).toBe(104);
    expect(h.recalcForUnit).toHaveBeenCalledWith(
      sessionManager,
      MUTATION_SESSION,
      TENANT,
      UNIT_ID,
      'manual_feeding_correction',
      { mutationInstant: MUTATION_INSTANT },
    );
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ amountDiffKg: 5, costDiff: 50 }),
      sessionManager,
    );
    expect(result.actualAmount).toBe(15);
    expect(result.feedCost).toBe(150);
  });

  it('keeps notes-only correction inside the aggregate/event path without derived writes', async () => {
    const h = harness();

    await h.execute({ notes: 'operator correction' });

    expect(h.feedingRecord?.notes).toBe('operator correction');
    expect(h.batchMutations.commitBatchTransition).not.toHaveBeenCalled();
    expect(h.applyStorageCorrection).not.toHaveBeenCalled();
    expect(h.withUnitGrowthMutation).not.toHaveBeenCalled();
    expect(h.recalcForUnit).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ amountDiffKg: 0, costDiff: 0 }),
      sessionManager,
    );
  });

  it('rejects meal-bound records before any durable mutation', async () => {
    const h = harness({ feedingRecord: record({ mealId: 'meal-1', pourIndex: 0 }) });

    await expect(h.execute({ actualAmount: 15 })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.feedingMutations.commitFeedingRecordTransition).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('rejects an unknown record before any durable mutation', async () => {
    const h = harness({ feedingRecord: null });

    await expect(h.execute({ actualAmount: 15 })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.feedingMutations.commitFeedingRecordTransition).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('propagates outbox failure so the coordinator-owned transaction cannot qualify', async () => {
    const h = harness({ outboxFailure: new Error('outbox-enqueue-failed') });

    await expect(h.execute({ actualAmount: 15 })).rejects.toThrow('outbox-enqueue-failed');
  });
});
