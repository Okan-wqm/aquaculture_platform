/**
 * DayPlanRecalcService (Faz 5 — P-31 gün içi recalc + histerezisli geçiş).
 *
 * Pinler: boş ünite kalan öğünleri iptal eder, planı kapatır, atamayı
 * otomatik pause eder (+unit_emptied event'i); kalan öğünler KENDİ
 * yüzdeleriyle yeni günlük toplamdan fiyatlanır ve recalcLog gerekçe taşır;
 * band sınırı buffer içinde geçilirse geçiş YAPILMAZ (salınım imkânsız),
 * buffer aşılırsa assignment + kalan öğün yemleri güncellenir ve
 * FeedTypeTransitioned yazılır; sıcaklık gerekçesi yeni okumayı kullanır.
 */
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import { ProtocolResolutionService } from '../services/protocol-resolution.service';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  FeedingProtocolV2,
  ProtocolFcrSource,
  FcrResolvedSource,
} from '../entities/feeding-protocol-v2.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { RECALC_LOG_MAX_ENTRIES } from '../constants';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const PROTOCOL = mock<FeedingProtocolV2>({
  id: 'protocol-1',
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 100,
      feedId: 'feed-a',
      feedCode: 'FA',
      feedName: 'Feed A',
      feedingRatePercent: 3,
      expectedFcr: 1.2,
    },
    {
      minWeightG: 100,
      maxWeightG: 500,
      feedId: 'feed-b',
      feedCode: 'FB',
      feedName: 'Feed B',
      feedingRatePercent: 2,
      expectedFcr: 1.4,
    },
  ],
  defaultMealSchedule: { mealsPerDay: 2, entries: [] },
  temperatureAdjustments: [{ minC: 5, maxC: 12, rateMultiplier: 0.5 }],
  settings: {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
});

interface HarnessOpts {
  /** `null` = plan yok; kısmi nesne makeDayPlan üzerine bindirilir. */
  dayPlan?: Partial<FeedingDayPlan> | null;
  meals?: FeedingMeal[];
  settledMeals?: FeedingMeal[];
  tankBatch?: Partial<TankBatch> | null;
  assignment?: Partial<ProtocolAssignment>;
}

function makeDayPlan(over: Partial<FeedingDayPlan> = {}): FeedingDayPlan {
  return mock<FeedingDayPlan>({
    id: 'plan-1',
    tenantId: TENANT,
    assignmentId: 'assign-1',
    protocolId: 'protocol-1',
    unitId: UNIT,
    unitCode: 'T-01',
    planDate: '2026-07-20',
    plannedTotalKg: 1.5,
    recalcLog: [],
    status: FeedingDayPlanStatus.PLANNED,
    snapshot: {
      avgWeightG: 50,
      fishCount: 1000,
      biomassKg: 50,
      waterTempC: null,
      temperatureSource: 'none',
      usingDefaultTemperature: true,
      bandIndex: 0,
      feed: { id: 'feed-a', code: 'FA', name: 'Feed A' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.2,
      fcrResolvedSource: FcrResolvedSource.BAND,
    },
    // W3: band/oran/FCR'ın CANLI değerleri ayrı kolonda; snapshot üretim anı
    // provenansı olarak donuk kalır (FARM-HIGH-247/FARM-MEDIUM-252).
    resolution: {
      resolvedAt: '2026-07-20T06:00:00.000Z',
      bandIndex: 0,
      feed: { id: 'feed-a', code: 'FA', name: 'Feed A' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.2,
      fcrResolvedSource: FcrResolvedSource.BAND,
      bandBasisWeightG: 50,
      waterTempC: null,
      temperatureSource: 'none',
    },
    ...over,
  });
}

function makeMeal(index: number, plannedKg: number, percent: number): FeedingMeal {
  return mock<FeedingMeal>({
    id: `meal-${index}`,
    mealIndex: index,
    dayPlanId: 'plan-1',
    percentOfDaily: percent,
    plannedKg,
    status: FeedingMealStatus.SCHEDULED,
    feedId: 'feed-a',
  });
}

function makeHarness(opts: HarnessOpts = {}) {
  const dayPlan = opts.dayPlan === null ? null : makeDayPlan(opts.dayPlan ?? {});
  const meals = opts.meals ?? [makeMeal(0, 0.9, 60), makeMeal(1, 0.6, 40)];
  const settled = opts.settledMeals ?? [];
  const tankBatch =
    opts.tankBatch === null
      ? null
      : mock<TankBatch>({
          tankId: UNIT,
          totalQuantity: 1000,
          totalBiomassKg: 50,
          avgWeightG: 50,
          ...opts.tankBatch,
        });
  const assignment = mock<ProtocolAssignment>({
    id: 'assign-1',
    protocolId: 'protocol-1',
    status: ProtocolAssignmentStatus.ACTIVE,
    unitCode: 'T-01',
    currentFeedId: 'feed-a',
    currentBandIndex: 0,
    totalTransitions: 0,
    overrides: {},
    ...opts.assignment,
  });

  const saved: unknown[] = [];
  const enqueued: Array<{ eventType: string }> = [];

  // Chainable query-builder double: setLock/where/andWhere/orderBy passthrough.
  let qbCall = 0;
  const createQueryBuilder = jest.fn();
  createQueryBuilder.mockImplementation(() => {
    qbCall += 1;
    const call = qbCall;
    const chain = {
      setLock: () => chain,
      where: () => chain,
      andWhere: () => chain,
      orderBy: () => chain,
      getOne: async () => (call === 1 ? dayPlan : null),
      getMany: async () => (call === 2 ? meals : settled),
    };
    return chain;
  });

  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === TankBatch) return tankBatch;
    if (entity === ProtocolAssignment) return assignment;
    if (entity === FeedingProtocolV2) return PROTOCOL;
    return null;
  });
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => {
    saved.push(entity);
    return entity;
  });

  const manager = mock<EntityManager>({ createQueryBuilder, findOne, save });
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string }) => {
      enqueued.push(event);
      return undefined as never;
    }),
  });
  const rateService = new ProtocolRateService();
  const service = new DayPlanRecalcService(outbox, new ProtocolResolutionService(rateService));
  return { service, manager, dayPlan, meals, assignment, saved, enqueued };
}

describe('DayPlanRecalcService.recalcForUnit', () => {
  it('cancels remaining meals, closes the plan and auto-pauses the assignment on an empty unit', async () => {
    const harness = makeHarness({ tankBatch: { totalQuantity: 0, totalBiomassKg: 0 } });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, 'harvest');

    expect(result?.outcome).toBe('cancelled_empty_unit');
    expect(harness.meals.every((meal) => meal.status === FeedingMealStatus.CANCELLED)).toBe(true);
    expect(harness.dayPlan!.status).toBe(FeedingDayPlanStatus.CANCELLED);
    expect(harness.assignment.status).toBe(ProtocolAssignmentStatus.PAUSED);
    expect(harness.enqueued.map((event) => event.eventType)).toContain(
      'FeedingProtocolAssignmentPaused',
    );
  });

  it('reprices remaining meals from the new daily total with their OWN percents and logs the reason', async () => {
    // Ölüm sonrası biomass 50→40kg: yeni günlük %3 × 40 = 1.2kg → 0.72 / 0.48
    const harness = makeHarness({ tankBatch: { totalBiomassKg: 40, avgWeightG: 50 } });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, 'mortality');

    expect(result?.outcome).toBe('repriced');
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(0.72);
    expect(harness.meals[1]!.plannedKg).toBeCloseTo(0.48);
    expect(harness.dayPlan!.plannedTotalKg).toBeCloseTo(1.2);
    expect(harness.dayPlan!.recalcLog.at(-1)?.reason).toBe('mortality');
  });

  /**
   * W8 / FARM-MEDIUM-286 — `recalcLog` ÜST SINIRSIZ büyüyordu ve tamamı
   * GraphQL'de açıktı. Bir gün planı sıcaklık, ölüm, hasat, transfer, ayıklama,
   * protokol/atama değişimi ve manuel geçişle yeniden hesaplanabilir; yoğun bir
   * ünitede satır günde onlarca girdi biriktiriyordu.
   */
  it('caps recalcLog at the shared limit while keeping the TOTAL count', async () => {
    const existing = Array.from({ length: RECALC_LOG_MAX_ENTRIES }, (_, i) => ({
      at: `2026-07-20T0${i % 10}:00:00.000Z`,
      reason: 'temperature' as const,
      remainingPlannedKg: 1,
      biomassKg: 50,
    }));
    const harness = makeHarness({
      tankBatch: { totalBiomassKg: 40, avgWeightG: 50 },
      dayPlan: { recalcLog: existing, recalcCount: RECALC_LOG_MAX_ENTRIES },
    });

    await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, 'mortality');

    expect(harness.dayPlan!.recalcLog).toHaveLength(RECALC_LOG_MAX_ENTRIES);
    // En YENİ girdi korunur, en eski düşer — kırpma budama değil pencere.
    expect(harness.dayPlan!.recalcLog.at(-1)?.reason).toBe('mortality');
    // Kırpma bilgi kaybı yaratmaz: toplam sayaç ilerler.
    expect(harness.dayPlan!.recalcCount).toBe(RECALC_LOG_MAX_ENTRIES + 1);
  });

  it('holds the current band inside the hysteresis buffer (no oscillation)', async () => {
    // 102g: yeni band min 100 + buffer 5 = 105 AŞILMADI → band 0 korunur.
    const harness = makeHarness({ tankBatch: { avgWeightG: 102, totalBiomassKg: 102 } });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, 'grading');

    expect(result?.transitioned).toBe(false);
    expect(harness.assignment.currentFeedId).toBe('feed-a');
    expect(harness.meals.every((meal) => meal.feedId === 'feed-a')).toBe(true);
  });

  it('transitions feed beyond the buffer: assignment + remaining meals + durable event (P-12)', async () => {
    const harness = makeHarness({ tankBatch: { avgWeightG: 110, totalBiomassKg: 110 } });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, 'grading');

    expect(result?.transitioned).toBe(true);
    expect(harness.assignment.currentFeedId).toBe('feed-b');
    expect(harness.assignment.currentBandIndex).toBe(1);
    expect(harness.assignment.totalTransitions).toBe(1);
    expect(harness.meals.every((meal) => meal.feedId === 'feed-b')).toBe(true);
    expect(harness.enqueued.map((event) => event.eventType)).toContain('FeedTypeTransitioned');
    // Yeni band oranı %2: 110kg × 2% = 2.2 → 1.32 / 0.88
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(1.32);
  });

  it('uses the fresh reading for temperature-triggered recalcs', async () => {
    const harness = makeHarness({});
    const result = await harness.service.recalcForUnit(
      harness.manager,
      TENANT,
      UNIT,
      'temperature',
      {
        newTemperatureC: 8, // 5–12°C bandı → ×0.5
      },
    );
    expect(result?.outcome).toBe('repriced');
    // 50kg × 3% × 0.5 = 0.75 → 0.45 / 0.30
    expect(harness.meals[0]!.plannedKg).toBeCloseTo(0.45);
    expect(harness.meals[1]!.plannedKg).toBeCloseTo(0.3);
  });

  it('returns null when the unit has no active day plan (nothing to recalc)', async () => {
    const harness = makeHarness({ dayPlan: null });
    const result = await harness.service.recalcForUnit(harness.manager, TENANT, UNIT, 'mortality');
    expect(result).toBeNull();
  });
});
