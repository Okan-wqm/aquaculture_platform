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
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent } from '@platform/event-contracts';
import { validateFarmEvent } from '@platform/event-contracts';
import type { IEventBus, IEventHandler } from '@platform/event-bus';

import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingClockService } from '../services/feeding-clock.service';
import { FeedingJobRunService } from '../services/feeding-job-run.service';
import { realFinalizationService } from './helpers/meal-finalization-double';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { FeedingMealStatus } from '../entities/feeding-meal.entity';
import { stub } from '@aquaculture/testing';
import { FeedingDailySummaryEventHandler } from '../../../../notification-service/src/notification/event-handlers/feeding-daily-summary.handler';
import { DeviceToken } from '../../../../notification-service/src/notification/entities/device-token.entity';
import {
  NotificationChannel,
  NotificationLog,
} from '../../../../notification-service/src/notification/entities/notification-log.entity';
import type { InAppNotificationService } from '../../../../notification-service/src/notification/services/in-app.service';
import type { NotificationDispatcherService } from '../../../../notification-service/src/notification/services/notification-dispatcher.service';

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
  globalThis.__summaryManager = stub<EntityManager>({ query: query as EntityManager['query'] });

  const growthApplier = stub<BiomassGrowthApplierService>({});
  const outboxPublisher = stub<OutboxPublisher>({
    // OutboxPublisher.enqueue returns Promise<void>; an async fn that returns
    // nothing already IS that shape, so the cast was never load-bearing.
    enqueue: jest.fn(async (event: BaseEvent) => {
      enqueued.push(event as BaseEvent & Record<string, unknown>);
    }),
  });
  const recalcService = stub<DayPlanRecalcService>({});

  const service = new FeedingCronV2Service(
    stub<DataSource>({}),
    createScheduledJobTestExecutor().executor,
    stub<MealPlanGeneratorService>({}),
    growthApplier,
    stub<WaterTemperatureService>({}),
    stub<FCRCalculationService>({}),
    outboxPublisher,
    stub<ProtocolFeedForecastService>({}),
    recalcService,
    // Gerçek finalize servisi (FARM-MEDIUM-276) — aynı outbox sahtesini
    // paylaşır, böylece finalize yolundan çıkan bir event de `enqueued`e düşer.
    realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
    stub<FeedingClockService>({}),
    stub<FeedingJobRunService>({}),
  );
  return { service, queries, enqueued };
}

describe('FeedingCronV2Service.summarizeTenant (W5)', () => {
  it('delivers the produced daily totals to the registered notification consumer', async () => {
    const harness = makeHarness({
      plans: [
        {
          id: 'dp-completed',
          unitId: 'unit-1',
          unitCode: 'T1',
          planDate: '2026-07-20',
          status: 'completed',
          plannedTotalKg: '60',
          actualKg: '50',
          unplannedActualKg: '3.5',
          thresholdPercent: 15,
        },
        {
          id: 'dp-open',
          unitId: 'unit-2',
          unitCode: 'T2',
          planDate: '2026-07-20',
          status: 'in_progress',
          plannedTotalKg: '40',
          actualKg: '20',
          unplannedActualKg: '0',
          thresholdPercent: 15,
        },
        {
          id: 'dp-skipped',
          unitId: 'unit-3',
          unitCode: 'T3',
          planDate: '2026-07-20',
          status: 'skipped',
          plannedTotalKg: '0',
          actualKg: null,
          unplannedActualKg: '0',
          thresholdPercent: 15,
        },
      ],
      openMeals: [
        { scheduledAt: new Date('2026-07-20T06:00:00Z'), status: FeedingMealStatus.SCHEDULED },
        { scheduledAt: new Date('2026-07-20T18:00:00Z'), status: FeedingMealStatus.SCHEDULED },
      ],
    });
    const subscribers = new Map<string, IEventHandler>();
    const bus: Pick<IEventBus, 'subscribeWildcard'> = {
      async subscribeWildcard(eventType, handler): Promise<void> {
        subscribers.set(eventType, handler);
      },
    };
    const recipientQuery = stub<SelectQueryBuilder<DeviceToken>>({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ userId: 'operator-1', token: 'fixture-device-token' }]),
    });
    const dispatchCommandNotification = jest
      .fn<
        ReturnType<NotificationDispatcherService['dispatchCommandNotification']>,
        Parameters<NotificationDispatcherService['dispatchCommandNotification']>
      >()
      .mockResolvedValue({ replayed: false });
    const createNotification = jest
      .fn<
        ReturnType<InAppNotificationService['createNotification']>,
        Parameters<InAppNotificationService['createNotification']>
      >()
      .mockResolvedValue(stub<NotificationLog>({ id: 'notification-1' }));
    const consumer = new FeedingDailySummaryEventHandler(
      stub<NotificationDispatcherService>({ dispatchCommandNotification }),
      { createNotification },
      stub<ConstructorParameters<typeof FeedingDailySummaryEventHandler>[2]>({
        createQueryBuilder: () => recipientQuery,
      }),
      bus,
    );
    await consumer.onModuleInit();
    await harness.service.summarizeTenant(TENANT, CLOCK);

    // Only transport/persistence are substituted: deliver the actual outbox
    // event to the actual registered handler, without rebuilding its payload.
    const summaries = harness.enqueued.filter((event) => event.eventType === 'FeedingDailySummary');
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    if (!summary) throw new Error('The farm producer did not enqueue its daily summary');
    expect(validateFarmEvent('FeedingDailySummary', summary)).toEqual({ valid: true });
    const subscriber = subscribers.get(summary.eventType);
    if (!subscriber)
      throw new Error('The notification consumer did not register for the produced event');
    expect(await subscriber.handle(summary)).toEqual({ kind: 'ack' });

    const title = 'Günlük yemleme özeti — 2026-07-20';
    const body =
      '1/3 ünite tamamlandı (%33), 73.5 kg atıldı (plan 100.0 kg), 1 ünite az beslendi, 1 öğün kaçırıldı';
    const deliveryId = `feeding-summary:${TENANT}:2026-07-20:operator-1`;
    expect(dispatchCommandNotification).toHaveBeenCalledTimes(1);
    expect(dispatchCommandNotification).toHaveBeenCalledWith({
      tenantId: TENANT,
      channel: NotificationChannel.PUSH,
      recipient: 'fixture-device-token',
      recipientLogRef: 'userId:operator-1',
      deliveryId,
      requestReference: deliveryId,
      source: 'notification-service.feeding-daily-summary-handler',
      subject: title,
      message: body,
      pushData: { userId: 'operator-1' },
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      TENANT,
      'operator-1',
      title,
      body,
      {
        type: 'FeedingDailySummary',
        planDate: '2026-07-20',
        unitsPlanned: 3,
        unitsCompleted: 1,
        unitsSkipped: 1,
        plannedTotalKg: 100,
        actualTotalKg: 73.5,
        underfedUnitCount: 1,
        missedMealCount: 1,
      },
      { deliveryId },
    );
  });

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
