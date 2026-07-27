/**
 * 05:30 süpürmesi (sweepTenant) — pinlenen sözleşme (FARM-MEDIUM-227):
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

import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';

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

declare global {
  var __sweepManager: EntityManager;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const OVERDUE = new Date(Date.now() - 7 * 60 * 60 * 1000);
const FRESH = new Date();

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface SweepFixture {
  meals: Array<Partial<FeedingMeal>>;
  dayPlans: Array<Partial<FeedingDayPlan>>;
  protocols: Array<Partial<FeedingProtocolV2>>;
}

function makeHarness(fixture: SweepFixture) {
  const callOrder: string[] = [];
  const enqueued: Array<{ eventType: string; unitCode?: string }> = [];

  const find = jest.fn();
  find.mockImplementation(async (entity: unknown, options: { where?: { status?: string } }) => {
    if (entity === FeedingMeal) {
      return fixture.meals.filter((meal) => meal.status === options?.where?.status);
    }
    if (entity === FeedingDayPlan) return fixture.dayPlans;
    if (entity === FeedingProtocolV2) return fixture.protocols;
    return [];
  });
  const save = jest.fn();
  save.mockImplementation(async (entity: { id?: string }) => {
    callOrder.push(`save:${entity.id}`);
    return entity;
  });
  const query = jest.fn().mockResolvedValue([]); // (c) rollup boş
  // Süpürme sonunda plan durumu HEDEFLENMİŞ update ile kapanır (açık öğün
  // sayımı üzerinden) — plan `in_progress`'te asılı kalmaz.
  const count = jest.fn().mockResolvedValue(0);
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = mock<EntityManager>({ find, save, query, count, update });
  globalThis.__sweepManager = manager;

  const lockUnitForGrowth = jest.fn();
  lockUnitForGrowth.mockImplementation(async (_m: unknown, _t: string, unitId: string) => {
    callOrder.push(`lock:${unitId}`);
    return { tankBatch: { tankId: unitId }, batches: new Map(), details: [] };
  });
  const applyGrowth = jest.fn().mockResolvedValue(undefined);
  const growthApplier = mock<BiomassGrowthApplierService>({ lockUnitForGrowth, applyGrowth });

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    mock<MealPlanGeneratorService>({}),
    growthApplier,
    mock<WaterTemperatureService>({}),
    mock<FCRCalculationService>({}),
    mock<OutboxPublisher>({
      enqueue: jest.fn(async (event: { eventType: string; unitCode?: string }) => {
        enqueued.push(event);
        return undefined as never;
      }),
    }),
    mock<ProtocolFeedForecastService>({}),
    mock<DayPlanRecalcService>({ recalcForUnit: jest.fn() }),
  );

  return { service, callOrder, enqueued, lockUnitForGrowth, applyGrowth, save };
}

describe('FeedingCronV2Service.sweepTenant (05:30)', () => {
  it('per_meal bayat kısmi finalize büyüme uygular — kilit meal yazımından ÖNCE', async () => {
    const meal: Partial<FeedingMeal> = {
      id: 'meal-1',
      unitId: 'unit-1',
      dayPlanId: 'dp-1',
      status: FeedingMealStatus.PARTIALLY_FED,
      scheduledAt: OVERDUE,
      actualKg: 6,
      plannedKg: 10,
    };
    const harness = makeHarness({
      meals: [meal],
      dayPlans: [
        {
          id: 'dp-1',
          protocolId: 'p-1',
          unitCode: 'T1',
          // FARM-CRITICAL-244: mod PLANIN kolonunda dondurulur.
          growthApplicationMode: 'per_meal',
          snapshot: { expectedFcr: 1.5 },
          resolution: { expectedFcr: 1.5 },
        } as never,
      ],
      protocols: [{ id: 'p-1', settings: { growthApplicationMode: 'per_meal' } } as never],
    });

    await harness.service.sweepTenant(TENANT);

    expect(meal.status).toBe(FeedingMealStatus.FED);
    expect(meal.varianceKg).toBeCloseTo(-4);
    expect(meal.variancePercent).toBeCloseTo(-40);

    const growthCall = harness.applyGrowth.mock.calls[0];
    expect(growthCall[3]).toBeCloseTo(4); // 6 kg / 1.5 FCR
    expect(growthCall[4]).toBeCloseTo(1.5);

    // K-1: ünitenin growth kilidi, o ünitenin meal save'inden ÖNCE.
    expect(harness.callOrder.indexOf('lock:unit-1')).toBeLessThan(
      harness.callOrder.indexOf('save:meal-1'),
    );
  });

  it('daily modda finalize büyüme UYGULAMAZ (rollup sahiplenir) ve kilit almaz', async () => {
    const meal: Partial<FeedingMeal> = {
      id: 'meal-2',
      unitId: 'unit-2',
      dayPlanId: 'dp-2',
      status: FeedingMealStatus.PARTIALLY_FED,
      scheduledAt: OVERDUE,
      actualKg: 6,
      plannedKg: 10,
    };
    const harness = makeHarness({
      meals: [meal],
      dayPlans: [
        {
          id: 'dp-2',
          protocolId: 'p-2',
          unitCode: 'T2',
          growthApplicationMode: 'daily',
          snapshot: { expectedFcr: 1.5 },
          resolution: { expectedFcr: 1.5 },
        } as never,
      ],
      protocols: [{ id: 'p-2', settings: { growthApplicationMode: 'daily' } } as never],
    });

    await harness.service.sweepTenant(TENANT);

    expect(meal.status).toBe(FeedingMealStatus.FED);
    // FARM-MEDIUM-276: ünite kilidi öğün yazımından ÖNCE, KOŞULSUZ alınır.
    // Eski hâl yalnız büyüme gerekince kilitliyordu; daily modda bu koşul hep
    // false olduğu için öğünler kilitsiz yazılıyor, aynı transaction'ın rollup
    // adımı ise aynı ünitenin Batch kilidini istiyordu (kanonik sıra ihlali).
    expect(harness.lockUnitForGrowth).toHaveBeenCalledWith(expect.anything(), TENANT, 'unit-2');
    // Büyüme yine de UYGULANMAZ — daily modda rollup sahiplenir.
    expect(harness.applyGrowth).not.toHaveBeenCalled();
  });

  it('penceresi geçmemiş öğünlere dokunmaz; missed işaretleme event unitCode taşır', async () => {
    const freshMeal: Partial<FeedingMeal> = {
      id: 'meal-fresh',
      unitId: 'unit-1',
      dayPlanId: 'dp-1',
      status: FeedingMealStatus.SCHEDULED,
      scheduledAt: FRESH,
    };
    const missedMeal: Partial<FeedingMeal> = {
      id: 'meal-missed',
      unitId: 'unit-1',
      dayPlanId: 'dp-1',
      status: FeedingMealStatus.SCHEDULED,
      scheduledAt: OVERDUE,
    };
    const harness = makeHarness({
      meals: [freshMeal, missedMeal],
      dayPlans: [
        {
          id: 'dp-1',
          protocolId: 'p-1',
          unitCode: 'T1',
          // FARM-CRITICAL-244: mod PLANIN kolonunda dondurulur.
          growthApplicationMode: 'per_meal',
          snapshot: { expectedFcr: 1.5 },
          resolution: { expectedFcr: 1.5 },
        } as never,
      ],
      protocols: [{ id: 'p-1', settings: { growthApplicationMode: 'per_meal' } } as never],
    });

    await harness.service.sweepTenant(TENANT);

    expect(freshMeal.status).toBe(FeedingMealStatus.SCHEDULED);
    expect(missedMeal.status).toBe(FeedingMealStatus.MISSED);
    const missedEvent = harness.enqueued.find((event) => event.eventType === 'MealMissed');
    expect(missedEvent?.unitCode).toBe('T1');
    // Kilit koşulsuz alınır (kanonik sıra), ama büyüme uygulanmaz: döküm
    // görmemiş missed öğünün çevrilecek kg'ı yoktur.
    expect(harness.lockUnitForGrowth).toHaveBeenCalledWith(expect.anything(), TENANT, 'unit-1');
    expect(harness.applyGrowth).not.toHaveBeenCalled();
  });
});
