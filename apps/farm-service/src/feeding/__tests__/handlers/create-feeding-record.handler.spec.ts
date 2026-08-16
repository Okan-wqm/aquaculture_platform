import { BadRequestException } from '@nestjs/common';
import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import type { EntityManager } from 'typeorm';

import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../../batch/services/batch-lifecycle-policy.service';
import type { BackdatePolicyService } from '../../../common/services/backdate-policy.service';
import { Feed } from '../../../feed/entities/feed.entity';
import { FeedingDayPlan } from '../../../feeding-protocol/entities/feeding-day-plan.entity';
import type { FeedingOperationSession } from '../../../feeding-protocol/feeding-operation-session';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import type { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { CreateFeedingRecordOperationExecutor } from '../../executors/create-feeding-record-operation.executor';
import { FeedingMethod, FeedingRecord, FishAppetite } from '../../entities/feeding-record.entity';
import type { FeedingLedgerService } from '../../services/feeding-ledger.service';
import {
  RecordingBatchAggregateMutationPort,
  RecordingFeedingAggregateMutationPort,
} from '../../../__tests__/support/durable-mutation-test-authority';
import { feedingProtocolTestMutationInstant } from '../../../__tests__/support/feeding-protocol-test-authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const FEED_ID = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const UNIT = '77777777-7777-4777-8777-777777777777';
const SITE = '88888888-8888-4888-8888-888888888888';
const SESSION = Object.freeze({}) as FeedingOperationSession;
const MUTATION_SESSION = Object.freeze({}) as TenantMutationSession;
const MUTATION_INSTANT = feedingProtocolTestMutationInstant('2026-06-10T08:00:00.000Z');

function mock<T>(value: Partial<T>): T {
  return value as T;
}

let sessionManager: EntityManager;
let sessionUnitId: string | null;
let sessionSiteId: string | null;

jest.mock('../../../feeding-protocol/feeding-operation-session', () => ({
  feedingOperationObservedAt: jest.fn(() => new Date('2026-06-10T08:00:00.000Z')),
  readFeedingOperationSession: jest.fn(() => ({
    manager: sessionManager,
    mutationSession: MUTATION_SESSION,
    tenantId: TENANT,
    operationId: '99999999-9999-4999-8999-999999999999',
    mutationInstant: MUTATION_INSTANT,
    generation: 1,
    attempt: 1,
    localDate: '2026-06-10',
    timezone: 'UTC',
    siteId: sessionSiteId,
    unitId: sessionUnitId,
  })),
}));

function command(feedingDate = new Date('2026-06-10T08:00:00Z')) {
  return {
    jobId: 'manual.feeding.record' as const,
    tenantId: TENANT,
    actorId: USER,
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: {
      batchId: BATCH_ID,
      tankId: UNIT,
      feedingDate,
      feedingTime: '08:00',
      feedId: FEED_ID,
      plannedAmount: 50,
      actualAmount: 50,
      feedingMethod: 'manual' as const,
      fishBehavior: {
        appetite: 'good' as const,
        feedingIntensity: 8,
      },
      fedBy: USER,
    },
  };
}

function savedRecord(): FeedingRecord {
  const now = new Date('2026-06-10T08:00:00Z');
  return mock<FeedingRecord>({
    id: 'record-1',
    tenantId: TENANT,
    batchId: BATCH_ID,
    tankId: UNIT,
    feedingDate: now,
    feedingTime: '08:00',
    feedingSequence: 1,
    totalMealsToday: 1,
    feedId: FEED_ID,
    plannedAmount: 50,
    actualAmount: 50,
    variance: 0,
    variancePercent: 0,
    feedingMethod: FeedingMethod.MANUAL,
    fishBehavior: { appetite: FishAppetite.GOOD, feedingIntensity: 8 },
    feedCostDecimal: null,
    fedBy: USER,
    createdAt: now,
    updatedAt: now,
  });
}

interface HarnessOptions {
  readonly activePlan?: FeedingDayPlan | null;
  readonly batch?: Batch;
  readonly policyFailure?: Error;
  readonly unitId?: string | null;
  readonly siteId?: string | null;
}

function harness(options: HarnessOptions = {}) {
  const batch =
    options.batch ??
    mock<Batch>({
      id: BATCH_ID,
      tenantId: TENANT,
      isActive: true,
      status: BatchStatus.ACTIVE,
      currentQuantity: 1000,
    });
  const plan =
    options.activePlan === undefined
      ? mock<FeedingDayPlan>({
          id: 'plan-1',
          siteId: SITE,
          resolution: mock<FeedingDayPlan['resolution']>({ expectedFcr: 1.25 }),
          snapshot: mock<FeedingDayPlan['snapshot']>({ expectedFcr: 1.25 }),
        })
      : options.activePlan;
  const tankBatch = mock<TankBatch>({
    id: 'tank-batch-1',
    tenantId: TENANT,
    tankId: UNIT,
    primaryBatchId: BATCH_ID,
    primaryBatchNumber: 'BATCH-1',
    totalQuantity: 1000,
    totalBiomassKg: 50,
    currentBiomassKg: 50,
    avgWeightG: 50,
    batchDetails: [
      {
        batchId: BATCH_ID,
        batchNumber: 'BATCH-1',
        quantity: 1000,
        avgWeightG: 50,
        biomassKg: 50,
        percentageOfTank: 100,
      },
    ],
  });
  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown, query?: { lock?: unknown }) => {
    if (entity === TankBatch) return tankBatch;
    if (entity === Feed) return mock<Feed>({ id: FEED_ID });
    if (entity === Batch) return batch;
    if (query?.lock) return null;
    return null;
  });
  const query = jest.fn().mockResolvedValue([{ biomass: 90, quantity: 1000 }]);
  const queryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(plan),
  };
  sessionManager = mock<EntityManager>({
    findOne,
    find: jest.fn().mockResolvedValue([batch]),
    query,
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  });
  sessionUnitId = options.unitId === undefined ? UNIT : options.unitId;
  sessionSiteId = options.siteId === undefined ? SITE : options.siteId;

  const validate = jest.fn();
  validate.mockImplementation(() => {
    if (options.policyFailure) throw options.policyFailure;
    return {
      context: 'feeding' as const,
      isBackdated: false,
      backdatedDays: 0,
      limitDays: 7,
    };
  });
  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const recordFeed = jest.fn().mockResolvedValue(savedRecord());
  const feedingMutations = new RecordingFeedingAggregateMutationPort();
  const batchMutations = new RecordingBatchAggregateMutationPort();
  const growthApplier = new BiomassGrowthApplierService(batchMutations);
  const withUnitGrowthMutation = jest.spyOn(growthApplier, 'withUnitGrowthMutation');
  const executor = new CreateFeedingRecordOperationExecutor(
    feedingMutations,
    mock<BackdatePolicyService>({ validate }),
    new BatchDomainService(new BatchLifecyclePolicyService()),
    mock<FeedingLedgerService>({ recordFeed }),
    growthApplier,
    mock<DayPlanRecalcService>({ recalcForUnit }),
  );
  return {
    executor,
    validate,
    findOne,
    query,
    feedingMutations,
    batchMutations,
    tankBatch,
    withUnitGrowthMutation,
    recalcForUnit,
    recordFeed,
  };
}

describe('CreateFeedingRecordOperationExecutor', () => {
  it('enforces backdate policy inside the verified operation session', async () => {
    const h = harness({ policyFailure: new BadRequestException('future date') });
    await expect(h.executor.executeFeedingRecordOperation(SESSION, command())).rejects.toThrow(
      'future date',
    );
    expect(h.validate).toHaveBeenCalledTimes(1);
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.recordFeed).not.toHaveBeenCalled();
  });

  it('rejects a command whose claim has no governed unit or Site', async () => {
    const h = harness({ unitId: null });
    await expect(h.executor.executeFeedingRecordOperation(SESSION, command())).rejects.toThrow(
      'no governed physical unit',
    );
    expect(h.recordFeed).not.toHaveBeenCalled();
  });

  it('rejects an empty batch before ledger mutation', async () => {
    const h = harness({
      batch: mock<Batch>({
        id: BATCH_ID,
        tenantId: TENANT,
        isActive: true,
        status: BatchStatus.ACTIVE,
        currentQuantity: 0,
      }),
    });
    await expect(
      h.executor.executeFeedingRecordOperation(SESSION, command()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.recordFeed).not.toHaveBeenCalled();
  });

  it('requires one active local-day plan instead of silently creating ledger-only state', async () => {
    const h = harness({ activePlan: null });
    await expect(h.executor.executeFeedingRecordOperation(SESSION, command())).rejects.toThrow(
      'No active feeding plan',
    );
    expect(h.recordFeed).not.toHaveBeenCalled();
  });

  it('updates the plan, growth projection, recalculation and ledger in one session manager', async () => {
    const h = harness();
    const result = await h.executor.executeFeedingRecordOperation(SESSION, command());

    expect(h.withUnitGrowthMutation).toHaveBeenCalledWith(
      sessionManager,
      MUTATION_SESSION,
      TENANT,
      UNIT,
      MUTATION_INSTANT,
      expect.any(Function),
    );
    expect(h.feedingMutations.incrementDayPlanUnplannedActual).toHaveBeenCalledWith(
      MUTATION_SESSION,
      { dayPlanId: 'plan-1', deltaKg: 50 },
    );
    expect(h.batchMutations.commitTankBatchTransition).toHaveBeenCalledWith(
      MUTATION_SESSION,
      expect.objectContaining({ intent: 'feeding_growth_applied', aggregate: h.tankBatch }),
    );
    expect(h.tankBatch.totalBiomassKg).toBe(90);
    expect(h.recalcForUnit).toHaveBeenCalledWith(
      sessionManager,
      MUTATION_SESSION,
      TENANT,
      UNIT,
      'unplanned_feed',
      { mutationInstant: MUTATION_INSTANT },
    );
    expect(h.recordFeed).toHaveBeenCalledWith(
      sessionManager,
      MUTATION_SESSION,
      TENANT,
      USER,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        operationId: '99999999-9999-4999-8999-999999999999',
        dayPlanId: 'plan-1',
        siteId: SITE,
        feedingMethod: FeedingMethod.MANUAL,
        extras: expect.objectContaining({
          fishBehavior: expect.objectContaining({ appetite: FishAppetite.GOOD }),
        }),
      }),
    );
    expect(result.id).toBe('record-1');
  });
});
