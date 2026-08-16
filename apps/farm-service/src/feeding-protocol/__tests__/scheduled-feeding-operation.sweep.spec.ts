/**
 * Scheduled 05:30 süpürmesi (sweepTenant) — pinlenen sözleşme (FARM-MEDIUM-227):
 *  - Bayat partially_fed finalize'ı per_meal modda BÜYÜME UYGULAR
 *    (growthKg = actualKg / snapshot.expectedFcr — recordMealFeeding
 *    finalize'ıyla aynı hesap); daily modda uygulamaz (rollup sahiplenir).
 *  - Growth kilidi (Batch → TankBatch) o ünitenin HERHANGİ bir meal
 *    yazımından ÖNCE alınır (K-1 kanonik sıra — meal-önce/kilit-sonra yok).
 *  - Penceresi geçmemiş öğünlere dokunulmaz; missed işaretleme MealMissed
 *    event'ini toplu yüklenen day-plan'ın unitCode'uyla yazar.
 */
import { DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { ScheduledFeedingOperationExecutor } from '../executors/scheduled-feeding-operation.executor';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { ProtocolFeedForecastExecutor } from '../executors/protocol-feed-forecast.executor';
import type { FeedingOperationSession } from '../feeding-operation-session';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { MealFinalizationAuthority } from '../services/meal-finalization.authority';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { RecordingFeedingAggregateMutationPort } from '../../__tests__/support/durable-mutation-test-authority';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import {
  createScheduledFeedingOperationTestExecutor,
  createScheduledSiteFeedingOperationTestCommand,
  feedingProtocolTestMutationInstant,
  FEEDING_PROTOCOL_TEST_TIMEZONES,
} from '../../__tests__/support/feeding-protocol-test-authority';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    async (
      _ds: unknown,
      _schema: string,
      _tenantId: string,
      cb: (qr: unknown) => Promise<unknown>,
    ) => cb({ manager: globalThis.__sweepManager }),
  ),
}));

jest.mock('../feeding-operation-session', () => ({
  feedingOperationObservedAt: jest.fn(() => new Date(activeObservedAt.getTime())),
  readFeedingOperationSession: jest.fn(() => ({
    manager: globalThis.__sweepManager,
    tenantId: TENANT,
    operationId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    attempt: 1,
    mutationSession: {},
    mutationInstant: MUTATION_INSTANT,
    observedAt: activeObservedAt,
    localDate: activeLocalDate,
    timezone: FEEDING_PROTOCOL_TEST_TIMEZONES.UTC,
    siteId: SITE,
    unitId: null,
  })),
}));

declare global {
  var __sweepManager: EntityManager;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const SESSION = Object.freeze({}) as FeedingOperationSession;
const FRESH = new Date('2026-07-20T05:30:00.000Z');
const SUMMARY_OBSERVED_AT = new Date('2026-07-21T18:00:00.000Z');
let activeObservedAt = FRESH;
let activeLocalDate = '2026-07-20';
const MUTATION_INSTANT = feedingProtocolTestMutationInstant(FRESH.toISOString());
const OVERDUE = new Date(FRESH.getTime() - 7 * 60 * 60 * 1000);

beforeAll(() => {
  jest.useFakeTimers({ now: FRESH });
});

beforeEach(() => {
  activeObservedAt = FRESH;
  activeLocalDate = '2026-07-20';
});

afterAll(() => {
  jest.useRealTimers();
});

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface SweepFixture {
  meals: Array<Partial<FeedingMeal>>;
  dayPlans: Array<
    Pick<FeedingDayPlan, 'id' | 'tenantId' | 'protocolId' | 'unitId' | 'unitCode'> & {
      growthPolicyVersion: number;
      growthApplicationMode: 'per_meal' | 'daily';
      resolution: { readonly expectedFcr: number };
    }
  >;
  protocols: Array<
    Pick<FeedingProtocolV2, 'id'> & {
      settings: Pick<FeedingProtocolV2['settings'], 'growthApplicationMode'>;
    }
  >;
  pendingRollups?: Array<{
    id: string;
    unitId: string;
    growthPolicyVersion: number;
    expectedFcr: number;
    appliedKg: number;
    totalActualKg: number;
  }>;
  missingGrowthUnitIds?: readonly string[];
  summaryRows?: Array<{
    id: string;
    unitId: string;
    unitCode: string;
    planDate: string;
    status: FeedingDayPlanStatus;
    plannedTotalKg: string | number;
    unplannedActualKg: string | number;
    actualKg: string | number | null;
    missedCount: string | number | null;
    thresholdPercent: number | null;
  }>;
}

function makeHarness(fixture: SweepFixture) {
  const callOrder: string[] = [];
  const enqueued: Array<{ eventType: string; unitCode?: string }> = [];

  const find = jest.fn();
  find.mockImplementation(async (entity: unknown) => {
    if (entity === FeedingDayPlan) return fixture.dayPlans;
    if (entity === FeedingProtocolV2) return fixture.protocols;
    return [];
  });
  const save = jest.fn();
  save.mockImplementation(async (entity: { id?: string }) => {
    callOrder.push(`save:${entity.id}`);
    return entity;
  });
  const query = jest.fn();
  query.mockImplementation(async (sql: string, parameters: readonly unknown[] = []) => {
    if (sql.includes('dp."rollupAppliedKg"::numeric AS "appliedKg"')) {
      return fixture.pendingRollups ?? [];
    }
    if (sql.includes('SELECT meal.id, meal."unitId", meal."dayPlanId"')) {
      callOrder.push('candidate');
      const cutoff = parameters[3];
      if (!(cutoff instanceof Date)) throw new Error('Candidate cutoff is not a Date');
      return fixture.meals
        .filter(
          (meal) =>
            (meal.status === FeedingMealStatus.SCHEDULED ||
              meal.status === FeedingMealStatus.PARTIALLY_FED) &&
            meal.scheduledAt instanceof Date &&
            meal.scheduledAt < cutoff,
        )
        .sort(
          (left, right) =>
            String(left.unitId).localeCompare(String(right.unitId)) ||
            Number(left.scheduledAt) - Number(right.scheduledAt) ||
            String(left.id).localeCompare(String(right.id)),
        )
        .map((meal) => ({ id: meal.id, unitId: meal.unitId, dayPlanId: meal.dayPlanId }));
    }
    if (sql.includes('SELECT meal.*')) {
      const candidateIds = new Set(
        Array.isArray(parameters[1])
          ? parameters[1].filter(
              (candidateId): candidateId is string => typeof candidateId === 'string',
            )
          : [],
      );
      const claimed = fixture.meals.filter((meal) => candidateIds.has(meal.id ?? ''));
      callOrder.push(`claim:${claimed[0]?.unitId ?? 'none'}`);
      return claimed;
    }
    if (sql.includes('AS "missedCount"')) return fixture.summaryRows ?? [];
    // DAILY growth rollup projection is empty in these fixtures.
    return [];
  });
  const count = jest.fn().mockResolvedValue(1);
  const manager = mock<EntityManager>({ find, save, query, count });
  globalThis.__sweepManager = manager;

  const applyGrowth = jest.fn().mockResolvedValue({
    beforeBiomassKg: 100,
    requestedGrowthKg: 0,
    appliedGrowthKg: 0,
    afterBiomassKg: 100,
  });
  const withUnitGrowthMutation = jest.fn();
  withUnitGrowthMutation.mockImplementation(
    async (_manager, _session, _tenantId, unitId, mutationInstant, work) => {
      callOrder.push(`lock:${unitId}`);
      if (fixture.missingGrowthUnitIds?.includes(unitId)) return null;
      return work({
        unitId,
        tankBatch: { tankId: unitId },
        batches: new Map(),
        details: [],
        mutationInstant,
        applyGrowth,
      });
    },
  );
  const growthApplier = mock<BiomassGrowthApplierService>({ withUnitGrowthMutation });
  const feedingMutations = new RecordingFeedingAggregateMutationPort(manager);
  feedingMutations.recordDayPlanGrowthApplication.mockImplementation(async (_session, input) => {
    callOrder.push(`rollup:${input.dayPlanId}`);
  });
  const recalcService = mock<DayPlanRecalcService>({
    recalcForUnit: jest.fn().mockResolvedValue(null),
  });
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string; unitCode?: string }) => {
      enqueued.push(event);
    }),
  });
  const mealFinalization = new MealFinalizationAuthority(feedingMutations, recalcService, outbox);

  const service = createScheduledFeedingOperationTestExecutor({
    feedingMutations,
    dataSource: mock<DataSource>({}),
    generator: mock<MealPlanGeneratorService>({}),
    growthApplier,
    mealFinalization,
    temperatureService: mock<WaterTemperatureService>({}),
    fcrCalculation: mock<FCRCalculationService>({}),
    outboxPublisher: outbox,
    forecastExecutor: mock<ProtocolFeedForecastExecutor>({}),
    mobileCommandReceipts: mock<MobileCommandReceiptService>({}),
  });

  return {
    service,
    callOrder,
    enqueued,
    withUnitGrowthMutation,
    applyGrowth,
    feedingMutations,
    save,
    query,
  };
}

const MORNING_SWEEP_COMMAND = createScheduledSiteFeedingOperationTestCommand({
  jobId: 'v2.morning.sweep',
  tenantId: TENANT,
  siteId: SITE,
  observedAt: FRESH,
  timezone: FEEDING_PROTOCOL_TEST_TIMEZONES.UTC,
});

const DAILY_SUMMARY_COMMAND = createScheduledSiteFeedingOperationTestCommand({
  jobId: 'v2.daily-summary.publish',
  tenantId: TENANT,
  siteId: SITE,
  observedAt: SUMMARY_OBSERVED_AT,
  timezone: FEEDING_PROTOCOL_TEST_TIMEZONES.UTC,
});

describe('ScheduledFeedingOperationExecutor.sweepTenant (05:30)', () => {
  it('per_meal bayat kısmi finalize büyüme uygular — kilit meal yazımından ÖNCE', async () => {
    const meal: Partial<FeedingMeal> = {
      id: 'meal-1',
      unitId: 'unit-1',
      dayPlanId: 'dp-1',
      status: FeedingMealStatus.PARTIALLY_FED,
      scheduledAt: OVERDUE,
      actualKg: 6,
      plannedKg: 10,
      tenantId: TENANT,
      pours: [{ pourIndex: 0, kg: 6, at: OVERDUE.toISOString(), by: 'user-1' }],
    };
    const harness = makeHarness({
      meals: [meal],
      dayPlans: [
        {
          id: 'dp-1',
          tenantId: TENANT,
          protocolId: 'p-1',
          unitId: 'unit-1',
          unitCode: 'T1',
          growthPolicyVersion: 1,
          growthApplicationMode: 'per_meal',
          resolution: { expectedFcr: 1.5 },
        },
      ],
      protocols: [{ id: 'p-1', settings: { growthApplicationMode: 'per_meal' } }],
    });

    await harness.service.executeScheduledOperation(SESSION, MORNING_SWEEP_COMMAND);

    expect(meal.status).toBe(FeedingMealStatus.FED);
    expect(meal.varianceKg).toBeCloseTo(-4);
    expect(meal.variancePercent).toBeCloseTo(-40);

    const growthCall = harness.applyGrowth.mock.calls[0];
    expect(growthCall[0]).toBeCloseTo(4); // 6 kg / 1.5 FCR
    expect(growthCall[1]).toBeCloseTo(1.5);

    // K-1: ünitenin growth kilidi, o ünitenin meal save'inden ÖNCE.
    expect(harness.callOrder.indexOf('lock:unit-1')).toBeLessThan(
      harness.callOrder.indexOf('save:meal-1'),
    );
  });

  it('daily modda finalize büyüme UYGULAMAZ; claim yine kanonik ünite kilidinin içinde kalır', async () => {
    const meal: Partial<FeedingMeal> = {
      id: 'meal-2',
      unitId: 'unit-2',
      dayPlanId: 'dp-2',
      status: FeedingMealStatus.PARTIALLY_FED,
      scheduledAt: OVERDUE,
      actualKg: 6,
      plannedKg: 10,
      tenantId: TENANT,
      pours: [{ pourIndex: 0, kg: 6, at: OVERDUE.toISOString(), by: 'user-1' }],
    };
    const harness = makeHarness({
      meals: [meal],
      dayPlans: [
        {
          id: 'dp-2',
          tenantId: TENANT,
          protocolId: 'p-2',
          unitId: 'unit-2',
          unitCode: 'T2',
          growthPolicyVersion: 1,
          growthApplicationMode: 'daily',
          resolution: { expectedFcr: 1.5 },
        },
      ],
      protocols: [{ id: 'p-2', settings: { growthApplicationMode: 'daily' } }],
    });

    await harness.service.executeScheduledOperation(SESSION, MORNING_SWEEP_COMMAND);

    expect(meal.status).toBe(FeedingMealStatus.FED);
    expect(harness.withUnitGrowthMutation).toHaveBeenCalledTimes(1);
    expect(harness.applyGrowth).not.toHaveBeenCalled();
    expect(harness.callOrder.indexOf('lock:unit-2')).toBeLessThan(
      harness.callOrder.indexOf('claim:unit-2'),
    );
  });

  it('interleaves daily meal closure and rollup under one monotonic multi-unit lock order', async () => {
    const makePartial = (unitId: string, mealId: string, dayPlanId: string) => ({
      id: mealId,
      unitId,
      dayPlanId,
      status: FeedingMealStatus.PARTIALLY_FED,
      scheduledAt: OVERDUE,
      actualKg: 6,
      plannedKg: 10,
      tenantId: TENANT,
      pours: [{ pourIndex: 0, kg: 6, at: OVERDUE.toISOString(), by: 'user-1' }],
    });
    const harness = makeHarness({
      meals: [makePartial('unit-b', 'meal-b', 'plan-b'), makePartial('unit-a', 'meal-a', 'plan-a')],
      dayPlans: [
        {
          id: 'plan-a',
          tenantId: TENANT,
          protocolId: 'protocol-a',
          unitId: 'unit-a',
          unitCode: 'A',
          growthPolicyVersion: 1,
          growthApplicationMode: 'daily',
          resolution: { expectedFcr: 1.5 },
        },
        {
          id: 'plan-b',
          tenantId: TENANT,
          protocolId: 'protocol-b',
          unitId: 'unit-b',
          unitCode: 'B',
          growthPolicyVersion: 1,
          growthApplicationMode: 'daily',
          resolution: { expectedFcr: 1.5 },
        },
      ],
      protocols: [
        { id: 'protocol-a', settings: { growthApplicationMode: 'daily' } },
        { id: 'protocol-b', settings: { growthApplicationMode: 'daily' } },
      ],
      pendingRollups: [
        {
          id: 'plan-b',
          unitId: 'unit-b',
          growthPolicyVersion: 1,
          expectedFcr: 1.5,
          appliedKg: 0,
          totalActualKg: 6,
        },
        {
          id: 'plan-a',
          unitId: 'unit-a',
          growthPolicyVersion: 1,
          expectedFcr: 1.5,
          appliedKg: 0,
          totalActualKg: 6,
        },
      ],
    });

    await harness.service.executeScheduledOperation(SESSION, MORNING_SWEEP_COMMAND);

    expect(harness.callOrder.filter((entry) => entry.startsWith('lock:'))).toEqual([
      'lock:unit-a',
      'lock:unit-b',
    ]);
    expect(harness.callOrder.indexOf('lock:unit-a')).toBeLessThan(
      harness.callOrder.indexOf('claim:unit-a'),
    );
    expect(harness.callOrder.indexOf('claim:unit-a')).toBeLessThan(
      harness.callOrder.indexOf('rollup:plan-a'),
    );
    expect(harness.callOrder.indexOf('rollup:plan-a')).toBeLessThan(
      harness.callOrder.indexOf('lock:unit-b'),
    );
    expect(harness.callOrder.indexOf('claim:unit-b')).toBeLessThan(
      harness.callOrder.indexOf('rollup:plan-b'),
    );
    expect(harness.feedingMutations.recordDayPlanGrowthApplication).toHaveBeenCalledTimes(2);
  });

  it('fails before journal advancement when a pending daily rollup has no growth lock scope', async () => {
    const harness = makeHarness({
      meals: [],
      dayPlans: [],
      protocols: [],
      missingGrowthUnitIds: ['unit-a'],
      pendingRollups: [
        {
          id: 'plan-a',
          unitId: 'unit-a',
          growthPolicyVersion: 1,
          expectedFcr: 1.5,
          appliedKg: 0,
          totalActualKg: 6,
        },
      ],
    });

    await expect(
      harness.service.executeScheduledOperation(SESSION, MORNING_SWEEP_COMMAND),
    ).rejects.toThrow('DAILY rollup work but no stock projection');

    expect(harness.applyGrowth).not.toHaveBeenCalled();
    expect(harness.feedingMutations.recordDayPlanGrowthApplication).not.toHaveBeenCalled();
  });

  it('penceresi geçmemiş öğünlere dokunmaz; missed işaretleme event unitCode taşır', async () => {
    const freshMeal: Partial<FeedingMeal> = {
      id: 'meal-fresh',
      unitId: 'unit-1',
      dayPlanId: 'dp-1',
      status: FeedingMealStatus.SCHEDULED,
      scheduledAt: FRESH,
      tenantId: TENANT,
    };
    const missedMeal: Partial<FeedingMeal> = {
      id: 'meal-missed',
      unitId: 'unit-1',
      dayPlanId: 'dp-1',
      status: FeedingMealStatus.SCHEDULED,
      scheduledAt: OVERDUE,
      tenantId: TENANT,
    };
    const harness = makeHarness({
      meals: [freshMeal, missedMeal],
      dayPlans: [
        {
          id: 'dp-1',
          tenantId: TENANT,
          protocolId: 'p-1',
          unitId: 'unit-1',
          unitCode: 'T1',
          growthPolicyVersion: 1,
          growthApplicationMode: 'per_meal',
          resolution: { expectedFcr: 1.5 },
        },
      ],
      protocols: [{ id: 'p-1', settings: { growthApplicationMode: 'per_meal' } }],
    });

    await harness.service.executeScheduledOperation(SESSION, MORNING_SWEEP_COMMAND);

    expect(freshMeal.status).toBe(FeedingMealStatus.SCHEDULED);
    expect(missedMeal.status).toBe(FeedingMealStatus.MISSED);
    const missedEvent = harness.enqueued.find((event) => event.eventType === 'MealMissed');
    expect(missedEvent?.unitCode).toBe('T1');
    // Büyüme uygulanmaz; buna rağmen claim/write kanonik ünite kilidinin içinde kalır.
    expect(harness.applyGrowth).not.toHaveBeenCalled();
    expect(harness.callOrder.indexOf('lock:unit-1')).toBeLessThan(
      harness.callOrder.indexOf('claim:unit-1'),
    );
    const candidateCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT meal.id, meal."unitId", meal."dayPlanId"'),
    );
    const claimCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT meal.*'),
    );
    expect(String(candidateCall?.[0])).toContain('meal."scheduledAt" < $4::timestamptz');
    expect(String(candidateCall?.[0])).toContain('LIMIT $5');
    expect(candidateCall?.[1]?.[3]).toEqual(new Date(FRESH.getTime() - 6 * 60 * 60 * 1000));
    expect(String(claimCall?.[0])).toContain('FOR UPDATE SKIP LOCKED');
  });
});

describe('ScheduledFeedingOperationExecutor.summarizeSite', () => {
  it('only projects the grace-closed previous local day with tenant-qualified SQL', async () => {
    activeObservedAt = SUMMARY_OBSERVED_AT;
    activeLocalDate = '2026-07-21';
    const harness = makeHarness({
      meals: [],
      dayPlans: [],
      protocols: [],
      summaryRows: [
        {
          id: 'dp-summary',
          unitId: 'unit-summary',
          unitCode: 'T-SUMMARY',
          planDate: '2026-07-20',
          status: FeedingDayPlanStatus.COMPLETED,
          plannedTotalKg: 10,
          unplannedActualKg: 1,
          actualKg: 8,
          missedCount: 2,
          thresholdPercent: 5,
        },
      ],
    });

    await harness.service.executeScheduledOperation(SESSION, DAILY_SUMMARY_COMMAND);

    const summaryQuery = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('AS "missedCount"'),
    );
    expect(String(summaryQuery?.[0])).toContain(
      'm."tenantId" = dp."tenantId" AND m."dayPlanId" = dp.id',
    );
    expect(String(summaryQuery?.[0])).toContain(
      'p.id = dp."protocolId" AND p."tenantId" = dp."tenantId"',
    );
    expect(String(summaryQuery?.[0])).toContain("dp.status <> 'cancelled'");
    expect(summaryQuery?.[1]).toEqual([
      TENANT,
      SITE,
      '2026-07-20',
      new Date(SUMMARY_OBSERVED_AT.getTime() - 6 * 60 * 60 * 1000),
    ]);
    expect(harness.enqueued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'FeedingDailySummary',
          planDate: '2026-07-20',
          unitsPlanned: 1,
          missedMealCount: 2,
          actualTotalKg: 9,
        }),
      ]),
    );
  });
});
