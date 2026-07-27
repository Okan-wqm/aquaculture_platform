/**
 * W5 gün özeti doğruluk pinleri (FARM-MEDIUM-256 / M-7).
 *
 * Denetimin üç ayağı:
 *  (a) özet `CURRENT_DATE` (DB oturum zonu = UTC) ile sorguluyordu — UTC'nin
 *      doğusundaki tenant YARININ boş planlarını, batısındaki DÜNÜNKİLERİ
 *      raporluyordu;
 *  (b) `missedMealCount` `status = 'missed'` sayıyordu; damgayı ERTESİ sabahki
 *      süpürme bastığı için akşam özetinde sayaç YAPISAL OLARAK her zaman 0
 *      çıkıyor, operatör "bugün hiç öğün kaçmadı" raporu alıyordu;
 *  (c) `cancelled` planlar varyansa giriyordu — tam hasat edilen tank her
 *      akşam "%100 az beslendi" alarmı üretiyordu.
 */
import { DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent } from '@platform/event-contracts';

import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingClockService } from '../services/feeding-clock.service';
import { FeedingJobRunService } from '../services/feeding-job-run.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { FeedingMealStatus } from '../entities/feeding-meal.entity';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    async (
      _ds: unknown,
      _schema: string,
      _tenantId: string,
      cb: (qr: unknown) => Promise<unknown>,
    ) => cb({ manager: globalThis.__summaryManager }),
  ),
}));

declare global {
  var __summaryManager: EntityManager;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-20T17:00:00Z'); // Oslo 19:00
const CLOCK = FeedingClockService.clockIn('Europe/Oslo', NOW);

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface SummaryRows {
  plans: Array<Record<string, unknown>>;
  openMeals: Array<{ scheduledAt: Date; status: FeedingMealStatus }>;
}

function makeHarness(rows: SummaryRows) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const enqueued: Array<BaseEvent & Record<string, unknown>> = [];

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return queries.length === 1 ? rows.plans : rows.openMeals;
  });
  globalThis.__summaryManager = mock<EntityManager>({ query: query as never });

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    mock<MealPlanGeneratorService>({}),
    mock<BiomassGrowthApplierService>({}),
    mock<WaterTemperatureService>({}),
    mock<FCRCalculationService>({}),
    mock<OutboxPublisher>({
      enqueue: jest.fn(async (event: BaseEvent) => {
        enqueued.push(event as BaseEvent & Record<string, unknown>);
        return undefined as never;
      }),
    }),
    mock<ProtocolFeedForecastService>({}),
    mock<DayPlanRecalcService>({}),
    mock<FeedingClockService>({}),
    mock<FeedingJobRunService>({}),
  );
  return { service, queries, enqueued };
}

describe('FeedingCronV2Service.summarizeTenant (W5)', () => {
  it('planDate TENANT’IN YEREL gününe bağlanır — CURRENT_DATE kullanılmaz', async () => {
    const harness = makeHarness({ plans: [], openMeals: [] });

    await harness.service.summarizeTenant(TENANT, CLOCK);

    const planQuery = harness.queries[0]!;
    expect(planQuery.sql).toContain('dp."planDate" = $2::date');
    expect(planQuery.sql).not.toContain('CURRENT_DATE');
    expect(planQuery.params[1]).toBe('2026-07-20');
  });

  it('cancelled planlar sorgudan DIŞLANIR (iptal edilen tank az-atım raporlamaz)', async () => {
    const harness = makeHarness({ plans: [], openMeals: [] });

    await harness.service.summarizeTenant(TENANT, CLOCK);

    expect(harness.queries[0]!.sql).toContain("dp.status <> 'cancelled'");
  });

  it('missedMealCount ZAMANDAN türetilir — damga beklenmez', async () => {
    const harness = makeHarness({
      plans: [
        {
          id: 'dp-1',
          unitId: 'unit-1',
          unitCode: 'T1',
          planDate: '2026-07-20',
          status: 'in_progress',
          plannedTotalKg: 30,
          unplannedActualKg: 0,
          actualKg: 30,
          thresholdPercent: 15,
        },
      ],
      openMeals: [
        // 08:00 UTC öğünü — 17:00'da penceresi çoktan geçti; damgası HENÜZ
        // basılmadı (süpürme yarın sabah koşacak) ama kaçmış SAYILIR.
        { scheduledAt: new Date('2026-07-20T06:00:00Z'), status: FeedingMealStatus.SCHEDULED },
        // 18:00 UTC öğünü — henüz penceresi geçmedi, kaçmış SAYILMAZ.
        { scheduledAt: new Date('2026-07-20T16:30:00Z'), status: FeedingMealStatus.SCHEDULED },
        // Süpürmenin daha önce damgaladığı öğün de sayılır.
        { scheduledAt: new Date('2026-07-20T04:00:00Z'), status: FeedingMealStatus.MISSED },
      ],
    });

    await harness.service.summarizeTenant(TENANT, CLOCK);

    const summary = harness.enqueued.find((event) => event.eventType === 'FeedingDailySummary');
    expect(summary).toBeDefined();
    expect(summary!.missedMealCount).toBe(2);
    expect(summary!.planDate).toBe('2026-07-20');
    expect(summary!.unitsPlanned).toBe(1);
  });

  it('gün-seviyesi az-atım eşiği aşılınca MealUnderfed(scope=day) yazılır', async () => {
    const harness = makeHarness({
      plans: [
        {
          id: 'dp-1',
          unitId: 'unit-1',
          unitCode: 'T1',
          planDate: '2026-07-20',
          status: 'completed',
          plannedTotalKg: 100,
          unplannedActualKg: 0,
          actualKg: 70, // −%30
          thresholdPercent: 15,
        },
      ],
      openMeals: [],
    });

    await harness.service.summarizeTenant(TENANT, CLOCK);

    const underfed = harness.enqueued.find((event) => event.eventType === 'MealUnderfed');
    expect(underfed).toMatchObject({ scope: 'day', unitId: 'unit-1', variancePercent: -30 });
  });
});
