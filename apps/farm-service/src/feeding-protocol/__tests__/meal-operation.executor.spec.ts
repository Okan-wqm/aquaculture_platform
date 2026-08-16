/**
 * MealOperationExecutor (Faz 5 — plan §2 akışı).
 *
 * Pinler: idempotency/replay tek operation-ledger otoritesindedir; executor
 * ikinci receipt otoritesi yaratmaz; döküm kümülatif eklenir ve ledger'a öğün
 * bağlarıyla (mealId/pourIndex) gider (D-8/P-05); finalize varyansı hesaplar,
 * per_meal büyümeyi actualKg/beklenenFCR ile uygular ve kalan öğünleri AYNI
 * tx'te recalc eder; az-atım eşiği aşımı MealUnderfed üretir (P-21); site
 * yetkisi yazma içinde fail-closed doğrulanır (SEC-HIGH-051); skipMeal
 * scheduled dışını reddeder ve MealSkipped yazar.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Role } from '@aquaculture/backend-common/decorators';
import { FEEDING_MEAL_MOBILE_COMMAND_V1 } from '@aquaculture/feeding-contracts';

import { MealOperationExecutor } from '../executors/meal-operation.executor';
import type { FeedingOperationCaller } from '../feeding-operation-command';
import type { FeedingOperationSession } from '../feeding-operation-session';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { MealFinalizationAuthority } from '../services/meal-finalization.authority';
import { FeedingLedgerService } from '../../feeding/services/feeding-ledger.service';
import { FeedingStorageCorrectionService } from '../../feeding/services/feeding-storage-correction.service';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../batch/services/batch-lifecycle-policy.service';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import {
  FeedingProtocolV2,
  ProtocolFcrSource,
  FcrResolvedSource,
} from '../entities/feeding-protocol-v2.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import {
  RecordingBatchAggregateMutationPort,
  RecordingFeedingAggregateMutationPort,
} from '../../__tests__/support/durable-mutation-test-authority';
import { feedingProtocolTestMutationInstant } from '../../__tests__/support/feeding-protocol-test-authority';

jest.mock('@aquaculture/backend-common/database', () => ({
  // Barrel'ın kalanı (DecimalTransformer vb.) entity yüklemeleri için GERÇEK
  // kalır; yalnız transaction sınırı test manager'ına yönlendirilir.
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    async (
      _ds: unknown,
      _schema: string,
      _tenantId: string,
      cb: (qr: unknown) => Promise<unknown>,
    ) => cb({ manager: globalThis.__mealExecManager }),
  ),
}));

jest.mock('../../batch/utils/tank-lookup.util', () => ({
  resolveTankSiteId: jest.fn(async () => 'site-1'),
}));

jest.mock('../feeding-operation-session', () => ({
  feedingOperationObservedAt: jest.fn(() => new Date('2026-07-20T12:00:00.000Z')),
  readFeedingOperationSession: jest.fn(() => ({
    manager: globalThis.__mealExecManager,
    tenantId: TENANT,
    operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    generation: 1,
    attempt: 1,
    mutationSession: {},
    mutationInstant: feedingProtocolTestMutationInstant('2026-07-20T12:00:00.000Z'),
    localDate: '2026-07-20',
    timezone: 'UTC',
    siteId: 'site-1',
    unitId: UNIT,
  })),
}));

declare global {
  var __mealExecManager: EntityManager;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BATCH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = Object.freeze({}) as FeedingOperationSession;

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const CALLER: FeedingOperationCaller = {
  sub: 'user-1',
  roles: [Role.MODULE_MANAGER],
  assignedSiteIds: [],
};

const ENVELOPE = {
  clientCommandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  payloadHash: 'hash',
  operationType: FEEDING_MEAL_MOBILE_COMMAND_V1.operationType,
};

interface HarnessOpts {
  meal?: Partial<FeedingMeal>;
  openMealsAfter?: number;
  growthMode?: 'per_meal' | 'daily';
  feedingRecord?: Partial<FeedingRecord> | null;
  feedPrice?: number;
  authorizationError?: ForbiddenException;
}

function makeHarness(opts: HarnessOpts = {}) {
  const initialActualKg = opts.meal?.actualKg ?? 0;
  const meal = mock<FeedingMeal>({
    id: MEAL,
    tenantId: TENANT,
    dayPlanId: PLAN,
    unitId: UNIT,
    siteId: 'site-1',
    mealIndex: 0,
    plannedKg: 10,
    actualKg: initialActualKg,
    pours:
      opts.meal?.pours ??
      (initialActualKg > 0
        ? [{ pourIndex: 0, kg: initialActualKg, at: '2026-07-20T07:00:00Z', by: 'user-1' }]
        : []),
    status: FeedingMealStatus.SCHEDULED,
    feedId: 'feed-1',
    ...opts.meal,
  });
  const dayPlan = mock<FeedingDayPlan>({
    id: PLAN,
    tenantId: TENANT,
    protocolId: 'protocol-1',
    unitId: UNIT,
    unitCode: 'T-01',
    status: FeedingDayPlanStatus.PLANNED,
    snapshot: {
      avgWeightG: 100,
      fishCount: 1000,
      biomassKg: 100,
      waterTempC: null,
      temperatureSource: 'none',
      usingDefaultTemperature: true,
      bandIndex: 0,
      feed: { id: 'feed-1', code: 'FA', name: 'Feed A' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.25,
      fcrResolvedSource: FcrResolvedSource.OVERRIDE,
    },
    resolution: {
      schemaVersion: 'protocol-resolution/v1',
      resolvedAt: new Date('2026-07-20T00:00:00.000Z').toISOString(),
      bandIndex: 0,
      feed: { id: 'feed-1', code: 'FA', name: 'Feed A' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.25,
      fcrResolvedSource: FcrResolvedSource.OVERRIDE,
      bandBasisWeightG: 100,
      waterTempC: null,
      temperatureSource: 'none',
    },
    growthPolicyVersion: 1,
    growthApplicationMode: opts.growthMode ?? 'per_meal',
  });
  const protocol = mock<FeedingProtocolV2>({
    id: 'protocol-1',
    settings: {
      autoTransition: true,
      transitionBufferG: 5,
      growthApplicationMode: opts.growthMode ?? 'per_meal',
      underfeedAlertThresholdPercent: 15,
      fcrSource: ProtocolFcrSource.BAND,
    },
    bands: [],
    defaultMealSchedule: { mealsPerDay: 1, entries: [] },
  });
  const batch = mock<Batch>({
    id: BATCH,
    isActive: true,
    status: BatchStatus.ACTIVE,
    currentQuantity: 1000,
  });
  const lockedUnit = {
    tankBatch: mock<TankBatch>({ tankId: UNIT, primaryBatchId: BATCH }),
    batches: new Map([[BATCH, batch]]),
    details: [],
  };

  const saved: unknown[] = [];
  const persistedMealStatuses: FeedingMealStatus[] = [];
  const enqueued: Array<{ eventType: string }> = [];

  const feedingRecord =
    opts.feedingRecord === null
      ? null
      : mock<FeedingRecord>({
          id: 'rec-1',
          tenantId: TENANT,
          batchId: BATCH,
          feedId: 'feed-1',
          mealId: MEAL,
          pourIndex: 0,
          actualAmount: 4,
          feedCost: 8,
          calculateVariance: jest.fn(),
          ...(opts.feedingRecord ?? {}),
        });
  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === FeedingMeal) return meal;
    if (entity === FeedingDayPlan) return dayPlan;
    if (entity === FeedingProtocolV2) return protocol;
    if (entity === Feed) return mock<Feed>({ id: 'feed-1', pricePerKg: opts.feedPrice ?? 2 });
    if (entity === FeedingRecord) return feedingRecord;
    return null;
  });
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => {
    saved.push(entity);
    if (entity === meal) persistedMealStatuses.push(meal.status);
    return entity;
  });
  const count = jest.fn();
  count.mockImplementation(async () => opts.openMealsAfter ?? 1);
  const managerQuery = jest.fn();
  managerQuery.mockImplementation(async () => [{ fromLocationId: 'loc-1', lotNumber: 'LOT-A' }]);

  const manager = mock<EntityManager>({ findOne, save, count, query: managerQuery });
  globalThis.__mealExecManager = manager;

  // Servis üyeleri tipli — double'lar ANOTASYONSUZ jest.fn() (Mock<any>) ile
  // yapısal atanabilir kalır; davranış mockImplementation ile verilir.
  const assertSiteAssignment = jest.fn();
  assertSiteAssignment.mockImplementation(() => {
    if (opts.authorizationError) throw opts.authorizationError;
  });
  const siteAuth = mock<SiteAuthorizationService>({ assertSiteAssignment });
  const applyGrowth = jest.fn().mockResolvedValue({
    beforeBiomassKg: 100,
    requestedGrowthKg: 0,
    appliedGrowthKg: 0,
    afterBiomassKg: 100,
  });
  const withUnitGrowthMutation = jest.fn();
  withUnitGrowthMutation.mockImplementation(
    async (_manager, _session, _tenantId, _unitId, mutationInstant, work) =>
      work({ ...lockedUnit, unitId: UNIT, mutationInstant, applyGrowth }),
  );
  const growthApplier = mock<BiomassGrowthApplierService>({ withUnitGrowthMutation });
  const recalcForUnit = jest.fn();
  recalcForUnit.mockResolvedValue(null);
  const recalcService = mock<DayPlanRecalcService>({ recalcForUnit });
  const recordFeed = jest.fn();
  recordFeed.mockImplementation(async () => mock({ id: 'rec-1' }));
  const feedingLedger = mock<FeedingLedgerService>({ recordFeed });
  const recordFeedCorrection = jest.fn();
  recordFeedCorrection.mockImplementation(async () => ({
    tracked: true,
    movements: [mock({ id: 'mv-1' })],
    usedSiteFallback: false,
    poolTotalKg: 100,
    idempotentHit: false,
  }));
  const stockMovementService = mock<StockMovementService>({
    recordFeedCorrection,
  });
  const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string }) => {
      enqueued.push(event);
    }),
  });
  const feedingMutations = new RecordingFeedingAggregateMutationPort(manager);
  const batchMutations = new RecordingBatchAggregateMutationPort(manager);
  const mealFinalization = new MealFinalizationAuthority(feedingMutations, recalcService, outbox);
  const storageCorrection = new FeedingStorageCorrectionService(stockMovementService);

  const service = new MealOperationExecutor(
    feedingMutations,
    batchMutations,
    siteAuth,
    growthApplier,
    recalcService,
    mealFinalization,
    feedingLedger,
    batchDomainService,
    storageCorrection,
    outbox,
  );

  return {
    service,
    meal,
    dayPlan,
    findOne,
    withUnitGrowthMutation,
    applyGrowth,
    recalcForUnit,
    recalcService,
    feedingLedger,
    feedingMutations,
    siteAuth,
    assertSiteAssignment,
    enqueued,
    saved,
    persistedMealStatuses,
    recordFeedCorrection,
    feedingRecord,
  };
}

const baseParams = (over: Record<string, unknown> = {}) => ({
  jobId: 'mobile.meal.record' as const,
  tenantId: TENANT,
  actorId: 'user-1',
  requestId: ENVELOPE.clientCommandId,
  caller: CALLER,
  mealId: MEAL,
  pourKg: 4,
  finalize: false,
  envelope: ENVELOPE,
  ...over,
});

describe('MealOperationExecutor.recordMealFeeding', () => {
  it('appends a pour cumulatively and routes it through the ledger with meal linkage (D-8/P-05)', async () => {
    const harness = makeHarness({
      meal: { actualKg: 3, pours: [{ pourIndex: 0, kg: 3, at: 'x', by: 'u' }] },
    });
    const result = await harness.service.executeRecordMealOperation(SESSION, baseParams());

    expect(result.status).toBe(FeedingMealStatus.PARTIALLY_FED);
    expect(result.actualKg).toBeCloseTo(7); // 3 + 4 kümülatif
    expect(harness.meal.pours).toHaveLength(2);
    const ledgerCall = (harness.feedingLedger.recordFeed as jest.Mock).mock.calls[0];
    expect(ledgerCall[6]).toMatchObject({
      mealId: MEAL,
      pourIndex: 1,
      dayPlanId: PLAN,
      siteId: 'site-1',
    });
    expect(harness.enqueued.map((event) => event.eventType)).toContain('MealFed');
    expect(harness.siteAuth.assertSiteAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1' }),
    );
    // finalize edilmedi → growth/recalc yok, varyans yok.
    expect(harness.applyGrowth).not.toHaveBeenCalled();
    expect(result.varianceKg).toBeNull();
  });

  it('finalize computes variance, applies per-meal growth (actual/FCR) and recalcs remaining meals', async () => {
    const harness = makeHarness({ meal: { actualKg: 6 }, openMealsAfter: 2 });
    const result = await harness.service.executeRecordMealOperation(
      SESSION,
      baseParams({ finalize: true }),
    );

    expect(result.status).toBe(FeedingMealStatus.FED);
    expect(result.actualKg).toBeCloseTo(10); // 6 + 4
    expect(result.varianceKg).toBeCloseTo(0);
    // growthKg = 10 / 1.25 = 8 (snapshot'taki OVERRIDE'lı FCR aynen)
    const growthCall = harness.applyGrowth.mock.calls[0];
    expect(growthCall[0]).toBeCloseTo(8);
    expect(growthCall[1]).toBe(1.25);
    expect(harness.recalcService.recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TENANT,
      UNIT,
      'meal_growth',
      {
        mutationInstant: expect.objectContaining({
          observedAt: '2026-07-20T12:00:00.000Z',
        }),
      },
    );
    expect(harness.dayPlan.status).toBe(FeedingDayPlanStatus.IN_PROGRESS);
  });

  it('persists the FED aggregate before recalculation can observe the remaining-meal projection', async () => {
    const harness = makeHarness({ meal: { actualKg: 6 }, openMealsAfter: 2 });

    await harness.service.executeRecordMealOperation(SESSION, baseParams({ finalize: true }));

    expect(harness.persistedMealStatuses).toContain(FeedingMealStatus.FED);
    expect(harness.feedingMutations.commitMealTransition.mock.invocationCallOrder[0]).toBeLessThan(
      harness.recalcForUnit.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects an unauthorized site after canonical locks and before every durable write', async () => {
    const harness = makeHarness({
      authorizationError: new ForbiddenException('site assignment required'),
    });

    await expect(
      harness.service.executeRecordMealOperation(SESSION, baseParams({ finalize: true })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const lockedFinds = harness.findOne.mock.calls
      .map(([entity, options], callIndex) => ({
        entity,
        callIndex,
        lock: (options as { lock?: { mode?: string } })?.lock?.mode,
      }))
      .filter((call) => call.lock === 'pessimistic_write');
    expect(lockedFinds.map((call) => call.entity)).toEqual([FeedingDayPlan, FeedingMeal]);
    expect(harness.withUnitGrowthMutation.mock.invocationCallOrder[0]).toBeLessThan(
      harness.findOne.mock.invocationCallOrder[lockedFinds[0]!.callIndex]!,
    );
    expect(harness.findOne.mock.invocationCallOrder[lockedFinds[1]!.callIndex]).toBeLessThan(
      harness.assertSiteAssignment.mock.invocationCallOrder[0]!,
    );
    expect(harness.feedingLedger.recordFeed).not.toHaveBeenCalled();
    expect(harness.feedingMutations.commitMealTransition).not.toHaveBeenCalled();
    expect(harness.applyGrowth).not.toHaveBeenCalled();
    expect(harness.saved).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });

  it('emits MealUnderfed(scope=meal) when the finalize variance crosses the threshold (P-21)', async () => {
    // planned 10, actual 4 → -%60 < -%15 eşiği
    const harness = makeHarness({ openMealsAfter: 0 });
    await harness.service.executeRecordMealOperation(SESSION, baseParams({ finalize: true }));

    const types = harness.enqueued.map((event) => event.eventType);
    expect(types).toContain('MealUnderfed');
    expect(harness.dayPlan.status).toBe(FeedingDayPlanStatus.COMPLETED); // açık öğün kalmadı
  });

  it('defers growth to the rollup in daily mode (no applyGrowth at finalize)', async () => {
    const harness = makeHarness({ growthMode: 'daily', meal: { actualKg: 6 } });
    await harness.service.executeRecordMealOperation(SESSION, baseParams({ finalize: true }));
    expect(harness.applyGrowth).not.toHaveBeenCalled();
    expect(harness.recalcService.recalcForUnit).not.toHaveBeenCalled();
  });

  it('rejects pours on a closed meal (only scheduled/partially_fed are feedable)', async () => {
    const harness = makeHarness({ meal: { status: FeedingMealStatus.FED } });
    await expect(
      harness.service.executeRecordMealOperation(SESSION, baseParams()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.feedingLedger.recordFeed).not.toHaveBeenCalled();
  });
});

describe('MealOperationExecutor.finalizeMeal', () => {
  const finalizeParams = {
    jobId: 'manual.meal.finalize' as const,
    tenantId: TENANT,
    actorId: 'user-1',
    requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    caller: CALLER,
    mealId: MEAL,
  };

  it('closes a durable partial meal without inventing a pour or ledger write', async () => {
    const harness = makeHarness({
      meal: {
        status: FeedingMealStatus.PARTIALLY_FED,
        actualKg: 4,
        pours: [{ pourIndex: 0, kg: 4, at: '2026-07-20T08:00:00Z', by: 'user-1' }],
      },
      openMealsAfter: 0,
    });

    const result = await harness.service.executeFinalizeMealOperation(SESSION, finalizeParams);

    expect(result).toMatchObject({
      id: MEAL,
      status: FeedingMealStatus.FED,
      actualKg: 4,
      varianceKg: -6,
      variancePercent: -60,
    });
    expect(harness.meal.pours).toEqual([
      { pourIndex: 0, kg: 4, at: '2026-07-20T08:00:00Z', by: 'user-1' },
    ]);
    expect(harness.feedingLedger.recordFeed).not.toHaveBeenCalled();
    expect(harness.applyGrowth).toHaveBeenCalledWith(3.2, 1.25);
    expect(harness.enqueued.map((event) => event.eventType)).toContain('MealUnderfed');
    expect(harness.dayPlan.status).toBe(FeedingDayPlanStatus.COMPLETED);
  });

  it('rejects a scheduled meal instead of manufacturing a zero-quantity feeding', async () => {
    const harness = makeHarness({ meal: { status: FeedingMealStatus.SCHEDULED } });

    await expect(
      harness.service.executeFinalizeMealOperation(SESSION, finalizeParams),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.feedingLedger.recordFeed).not.toHaveBeenCalled();
    expect(harness.feedingMutations.commitMealTransition).not.toHaveBeenCalled();
  });
});

describe('MealOperationExecutor.correctMealPour', () => {
  // Her test TAZE pours dizisi alır — paylaşılan referans testler arası
  // mutasyon kirliliği yaratır (kümülatif düzeltme sayaçları).
  const fedMeal = () => ({
    status: FeedingMealStatus.FED,
    actualKg: 4,
    plannedKg: 10,
    pours: [{ pourIndex: 0, kg: 4, at: '2026-07-20T08:00:00Z', by: 'user-1' }],
  });

  const correctionParams = (correctedKg: number) => ({
    jobId: 'manual.meal.correct' as const,
    tenantId: TENANT,
    actorId: 'user-2',
    requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    caller: CALLER,
    mealId: MEAL,
    pourIndex: 0,
    correctedKg,
  });

  it('upward correction: extra OUT movement + record/meal/batch deltas + growth delta + event (C-11)', async () => {
    const harness = makeHarness({ meal: fedMeal() });
    const result = await harness.service.executeCorrectMealOperation(SESSION, correctionParams(6));

    // Öğün + pour denetim izi
    expect(result.actualKg).toBeCloseTo(6);
    const pour = harness.meal.pours![0]!;
    expect(pour.kg).toBe(6);
    expect(pour.originalKg).toBe(4);
    expect(pour.correctedBy).toBe('user-2');
    expect(pour.corrections).toBe(1);
    // Finalize edilmiş öğünde varyans yeniden hesaplanır (6 - 10 = -4)
    expect(result.varianceKg).toBeCloseTo(-4);
    // Ledger kaydı + batch delta'ları
    expect(harness.feedingRecord!.actualAmount).toBe(6);
    expect(harness.feedingRecord!.feedCost).toBeCloseTo(12); // 2/kg × 6
    // Ek OUT: fark kadar, meal-correct idempotency anahtarıyla
    const correction = harness.recordFeedCorrection.mock.calls[0]![1];
    expect(correction.deltaKg).toBeCloseTo(2);
    expect(correction.idempotencyKey).toBe(`meal-correct-${MEAL}-0-1`);
    // Growth delta = +2 / 1.25 = 1.6 ve recalc pour_correction gerekçesiyle
    const growthCall = harness.applyGrowth.mock.calls[0]!;
    expect(growthCall[0]).toBeCloseTo(1.6);
    expect(harness.recalcService.recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TENANT,
      UNIT,
      'pour_correction',
      {
        mutationInstant: expect.objectContaining({
          observedAt: '2026-07-20T12:00:00.000Z',
        }),
      },
    );
    expect(harness.enqueued.map((event) => event.eventType)).toContain('FeedingRecordUpdated');
  });

  it('downward correction: RETURN to the original lot/location resolved from the deduction movement', async () => {
    const harness = makeHarness({ meal: fedMeal() });
    const result = await harness.service.executeCorrectMealOperation(SESSION, correctionParams(3));

    expect(result.actualKg).toBeCloseTo(3);
    const correction = harness.recordFeedCorrection.mock.calls[0]![1];
    expect(correction.deltaKg).toBeCloseTo(-1);
    expect(correction.sourceDeductionKey).toBe(`meal-deduct-${MEAL}-0`);
    // Growth delta NEGATİF: -1 / 1.25 = -0.8 (büyüme geri alınır)
    const growthCall = harness.applyGrowth.mock.calls[0]!;
    expect(growthCall[0]).toBeCloseTo(-0.8);
  });

  it('keeps the original unit cost when the current feed catalogue price changed (FARM-LOW-268)', async () => {
    const harness = makeHarness({ meal: fedMeal(), feedPrice: 99 });
    await harness.service.executeCorrectMealOperation(SESSION, correctionParams(6));

    // Original ledger fact is 4kg / 8 = 2 per kg. The correction must not
    // rewrite it at today's unrelated 99 per kg catalogue value.
    expect(harness.feedingRecord!.feedCost).toBe(12);
  });

  it('no-op when the corrected amount equals the pour (no movement, no event)', async () => {
    const harness = makeHarness({ meal: fedMeal() });
    await harness.service.executeCorrectMealOperation(SESSION, correctionParams(4));
    expect(harness.recordFeedCorrection).not.toHaveBeenCalled();
    expect(harness.enqueued).toHaveLength(0);
  });

  it('fails closed when the pour has no ledger record (P-05 divergence surfaces loudly)', async () => {
    const harness = makeHarness({ meal: fedMeal(), feedingRecord: null });
    await expect(
      harness.service.executeCorrectMealOperation(SESSION, correctionParams(6)),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('MealOperationExecutor.skipMeal', () => {
  it('skips a scheduled meal with a durable MealSkipped event', async () => {
    const harness = makeHarness({ openMealsAfter: 0 });
    const result = await harness.service.executeSkipMealOperation(SESSION, {
      jobId: 'manual.meal.skip',
      tenantId: TENANT,
      actorId: 'user-1',
      requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      caller: CALLER,
      mealId: MEAL,
      reason: 'balık iştahsız',
    });
    expect(result.status).toBe(FeedingMealStatus.SKIPPED);
    expect(harness.enqueued.map((event) => event.eventType)).toContain('MealSkipped');
  });

  it('rejects skipping a non-scheduled meal', async () => {
    const harness = makeHarness({ meal: { status: FeedingMealStatus.PARTIALLY_FED } });
    await expect(
      harness.service.executeSkipMealOperation(SESSION, {
        jobId: 'manual.meal.skip',
        tenantId: TENANT,
        actorId: 'user-1',
        requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        caller: CALLER,
        mealId: MEAL,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('acquires locks in the canonical DayPlan → Meal order (K-1 — no AB-BA with record/correct)', async () => {
    const harness = makeHarness({ openMealsAfter: 0 });
    await harness.service.executeSkipMealOperation(SESSION, {
      jobId: 'manual.meal.skip',
      tenantId: TENANT,
      actorId: 'user-1',
      requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      caller: CALLER,
      mealId: MEAL,
      reason: 'balık iştahsız',
    });
    const lockedEntities = harness.findOne.mock.calls
      .filter(
        ([, options]) =>
          (options as { lock?: { mode?: string } })?.lock?.mode === 'pessimistic_write',
      )
      .map(([entity]) => entity);
    expect(lockedEntities).toEqual([FeedingDayPlan, FeedingMeal]);
    // Ön-okuma kilitsizdir: ilk FeedingMeal findOne'ı lock seçeneği taşımaz.
    const firstMealCall = harness.findOne.mock.calls.find(([entity]) => entity === FeedingMeal);
    expect((firstMealCall?.[1] as { lock?: unknown })?.lock).toBeUndefined();
  });
});
