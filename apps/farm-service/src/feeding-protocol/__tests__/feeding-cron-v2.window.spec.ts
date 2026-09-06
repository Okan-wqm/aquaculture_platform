/**
 * 15 dk'lık öğün-penceresi süpürmesi — YENİDEN ÜRETİM sözleşmesi
 * (FARM-MEDIUM-271).
 *
 * ## Neyi pinliyor
 *
 * `MealWindowUpcoming`, teslim-semantiği kaydında `reproducible` olarak
 * sınıflanmış ve gerekçesi şöyle yazılmıştı: *"15 dk'lık pencere cron'u,
 * kurşun penceresi içindeki her öğün için YENİDEN yayar; kaybolan bir batch en
 * fazla bir tick'lik ön-takviye süresine mal olur."* `1809400000000`
 * migration'ının docblock'u da aynı şeyi söylüyordu.
 *
 * Sorgu ise `windowNotifiedAt IS NULL` filtreliyordu ve damga, event'le AYNI
 * transaction'da basılıyordu — yani her öğün ÖMÜR BOYU tam bir kez
 * bildiriliyordu. Kaybolan tek bir batch, o öğün için aeratör ön-takviyesini
 * tamamen düşürüyordu; iki ayrı dosyadaki "yeniden üretilir" ifadesi kodun
 * karşılığı olmayan bir iddiaydı.
 *
 * ## Bu spec neden sahte bir Postgres kuruyor
 *
 * Assertion "SQL şu string'i içeriyor" olsaydı, predikat yanlış yazıldığında
 * da yeşil kalırdı. Sahte `manager.query`, süpürmenin BAĞLADIĞI parametrelerle
 * predikatı fixture'a KENDİSİ uygular: davranış test edilir, metin değil.
 */
const managerQuery = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    _ds: unknown,
    _schema: string,
    _tenantId: string,
    cb: (qr: { manager: { query: typeof managerQuery } }) => Promise<void>,
  ) => cb({ manager: { query: managerQuery } }),
}));

import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent, MealWindowUpcomingEvent } from '@platform/event-contracts';

import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingClockService } from '../services/feeding-clock.service';
import { FeedingJobRunService } from '../services/feeding-job-run.service';
import { realFinalizationService } from './helpers/meal-finalization-double';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { stub } from '@aquaculture/testing';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-20T08:00:00.000Z');

/** Bir `feeding_meals` satırının süpürme için anlamlı alanları. */
interface MealRow {
  id: string;
  scheduledAt: Date;
  windowNotifiedAt: Date | null;
}

function makeHarness(rows: MealRow[]) {
  const enqueued: MealWindowUpcomingEvent[] = [];
  const stamped: string[][] = [];

  managerQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (String(sql).includes('UPDATE "feeding_meals"')) {
      stamped.push(params[1] as string[]);
      return [];
    }
    // Sahte Postgres: predikatı, süpürmenin YAZDIĞI SQL'e ve BAĞLADIĞI
    // parametrelere göre uygular.
    //
    // Yeniden-bildirim dalını SQL'den okumak şart: yalnız parametrelere
    // bakılsaydı, `OR "windowNotifiedAt" < $4` cümlesi sorgudan silindiğinde
    // parametre hâlâ bağlı olduğu için sahte onu uygulamaya devam eder ve
    // testler yeşil kalırdı — ilk hâli tam olarak öyleydi ve kusuru
    // yakalamıyordu.
    const allowsRenotify = /"windowNotifiedAt"\s*<\s*\$4/.test(String(sql));
    const [, windowStart, windowEnd, renotifyBefore] = params as [
      string,
      Date,
      Date,
      Date | undefined,
    ];
    return rows
      .filter((row) => row.scheduledAt >= windowStart && row.scheduledAt < windowEnd)
      .filter(
        (row) =>
          row.windowNotifiedAt === null ||
          (allowsRenotify && renotifyBefore !== undefined && row.windowNotifiedAt < renotifyBefore),
      )
      .map((row) => ({
        id: row.id,
        unitId: 'unit-1',
        dayPlanId: 'dp-1',
        mealIndex: 0,
        scheduledAt: row.scheduledAt,
        feedId: 'feed-1',
        plannedKg: 1,
        unitCode: 'T-1',
        protocolId: 'proto-1',
        minDissolvedOxygen: null,
        lowOxygenReduction: null,
      }));
  });

  const growthApplier = stub<BiomassGrowthApplierService>({});
  const outboxPublisher = stub<OutboxPublisher>({
    // Üretim imzası generic (`<TEvent extends BaseEvent>`); double da öyle
    // olmalı, yoksa cast'la susturmak gerekirdi. Dönüş tipi de gerçeğinden
    // alınır: `OutboxPublisher.enqueue` → `Promise<void>`.
    enqueue: jest.fn(async (event: BaseEvent): Promise<void> => {
      enqueued.push(event as MealWindowUpcomingEvent);
    }),
  });
  const recalcService = stub<DayPlanRecalcService>({});

  const service = new FeedingCronV2Service(
    stub<DataSource>({
      createQueryRunner: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([{ acquired: true }]),
        release: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    stub<MealPlanGeneratorService>({}),
    growthApplier,
    stub<WaterTemperatureService>({}),
    stub<FCRCalculationService>({}),
    outboxPublisher,
    stub<ProtocolFeedForecastService>({}),
    recalcService,
    realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
    stub<FeedingClockService>({}),
    stub<FeedingJobRunService>({}),
  );

  // Tenant keşfi ve sıcaklık sapma süpürmesi bu spec'in konusu değil.
  Object.defineProperty(service, 'feedingTenants', {
    value: jest.fn().mockResolvedValue([TENANT]),
  });
  Object.defineProperty(service, 'temperatureDriftSweep', {
    value: jest.fn().mockResolvedValue(undefined),
  });

  jest.useFakeTimers().setSystemTime(NOW);
  return { service, enqueued, stamped };
}

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

/** Pencere içinde (60 dk kurşun): 30 dk sonraki öğün. */
const IN_WINDOW = new Date(NOW.getTime() + 30 * 60_000);

describe('FeedingCronV2Service.mealWindowSweep — pencere içinde yeniden üretim', () => {
  it('hiç bildirilmemiş öğünü bildirir ve damgalar', async () => {
    const h = makeHarness([{ id: 'meal-1', scheduledAt: IN_WINDOW, windowNotifiedAt: null }]);

    await h.service.mealWindowSweep();

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.meals.map((meal) => meal.mealId)).toEqual(['meal-1']);
    expect(h.stamped[0]).toEqual(['meal-1']);
  });

  it('ÖNCEKİ tick’te bildirilmiş ama hâlâ pencerede olan öğünü YENİDEN bildirir', async () => {
    // Kusurun tam senaryosu: 20 dk önce bir batch yayıldı ve kayboldu. Öğün
    // hâlâ 30 dk uzakta — ön-takviye için bol vakit var — ama eski predikat
    // onu bir daha ADAY YAPMIYORDU.
    const h = makeHarness([
      {
        id: 'meal-1',
        scheduledAt: IN_WINDOW,
        windowNotifiedAt: new Date(NOW.getTime() - 20 * 60_000),
      },
    ]);

    await h.service.mealWindowSweep();

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.meals.map((meal) => meal.mealId)).toEqual(['meal-1']);
  });

  it('AYNI tick içinde tekrar koşarsa yeniden yaymaz (retry çift bildirim üretmez)', async () => {
    const h = makeHarness([
      {
        id: 'meal-1',
        scheduledAt: IN_WINDOW,
        // 2 dk önce bildirildi — yeniden-bildirim aralığının (15 dk) içinde.
        windowNotifiedAt: new Date(NOW.getTime() - 2 * 60_000),
      },
    ]);

    await h.service.mealWindowSweep();

    expect(h.enqueued).toHaveLength(0);
  });

  it('penceresi henüz açılmamış öğüne dokunmaz', async () => {
    const h = makeHarness([
      {
        id: 'meal-far',
        // 90 dk sonra — 60 dk'lık kurşun penceresinin dışında.
        scheduledAt: new Date(NOW.getTime() + 90 * 60_000),
        windowNotifiedAt: null,
      },
    ]);

    await h.service.mealWindowSweep();

    expect(h.enqueued).toHaveLength(0);
  });
});
