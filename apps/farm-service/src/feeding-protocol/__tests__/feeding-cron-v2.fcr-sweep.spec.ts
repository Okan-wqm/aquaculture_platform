/**
 * 18:00 FCR alert süpürmesi (C-1) — İLK durable FCRAlert emisyonu.
 *
 * Pinlenen sözleşme:
 *  - Eşikler legacy analyzeFCR ile birebir: varyans >%10 warning, >%20
 *    critical; eşik altı batch event üretmez.
 *  - FCR tek otoriteden TOPLU, her batch'in SON TARTIMINDA hesaplanır
 *    (FCRCalculationService.calculateFcrAtLastWeighingMany) — saklı
 *    `batches_v2.fcr.actual` kopyası değil (FARM-CRITICAL-444). Yalnız
 *    'converting' hükmü hedefe karşı tartılır.
 *  - İş sorgusu canlı batch'leri OPERATIONAL_BATCH_STATUSES ile seçer
 *    (assertFeedable'ın kümesi), bağlı parametre olarak.
 *  - Hedef P-14 zincirinden okunur (FCRCalculationService.getTargetFCRForBatch)
 *    — batch.fcr.target kopyası değil.
 *  - Trend YALNIZ eşiği aşan batch'ler için sorgulanır (ölçek disiplini).
 *  - Event outbox'a AYNI tenant transaction manager'ıyla yazılır.
 *
 * Bu spec `manager.query`'yi taklit eder; iş sorgusunun GERÇEK satırları
 * seçtiğini yalnız gerçek Postgres kanıtlar:
 * `src/__tests__/e2e/fcr-alert-sweep.postgres.spec.ts`.
 */
const managerQuery = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    ds: unknown,
    schema: string,
    tenantId: string,
    cb: (qr: { manager: { query: typeof managerQuery } }) => Promise<void>,
  ) => cb({ manager: { query: managerQuery } }),
}));

import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingClockService } from '../services/feeding-clock.service';
import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
import { FeedingJobRunService } from '../services/feeding-job-run.service';
import { realFinalizationService } from './helpers/meal-finalization-double';
import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  FCRCalculationService,
  FcrAtLastWeighing,
} from '../../growth/services/fcr-calculation.service';
import { BatchStatus, OPERATIONAL_BATCH_STATUSES } from '../../batch/entities/batch.entity';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import type { FCRAlertEvent } from '@platform/event-contracts';
import { stub } from '@aquaculture/testing';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('FeedingCronV2Service.sweepFcrForTenant (C-1)', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  // W5 (FARM-LOW-291): süpürme artık batch başına değil TOPLU okur.
  const calculateFcrAtLastWeighingMany = jest.fn();
  const getTargetFCRForBatches = jest.fn();
  const analyzeFCRTrendMany = jest.fn();

  const growthApplier = stub<BiomassGrowthApplierService>({});
  const outboxPublisher = stub<OutboxPublisher>({ enqueue });
  const recalcService = stub<DayPlanRecalcService>({ recalcForUnit: jest.fn() });

  const service = new FeedingCronV2Service(
    stub<DataSource>({}),
    createScheduledJobTestExecutor().executor,
    stub<MealPlanGeneratorService>({}),
    growthApplier,
    stub<WaterTemperatureService>({}),
    stub<FCRCalculationService>({
      calculateFcrAtLastWeighingMany,
      getTargetFCRForBatches,
      analyzeFCRTrendMany,
    }),
    outboxPublisher,
    stub<ProtocolFeedForecastService>({}),
    recalcService,
    realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
    stub<FeedingClockService>({}),
    stub<FeedingJobRunService>({}),
    stub<SiteTimeZoneService>({}),
  );

  const WEIGHED_ON = new Date('2026-10-10T12:00:00.000Z');

  type WeighedVerdict = Extract<FcrAtLastWeighing, { readonly weighedOn: Date }>;

  /** A weighed batch's verdict (its feed and growth are not read here). */
  const weighed = (kind: WeighedVerdict['kind'], fcr: number): WeighedVerdict => ({
    kind,
    weighedOn: WEIGHED_ON,
    fcr,
    totalFeed: 0,
    totalGrowth: 0,
    removedBiomassKg: 0,
  });
  const converting = (fcr: number): WeighedVerdict => weighed('converting', fcr);

  /**
   * The live batches the work query returns, with the authority's verdict at
   * each one's last weighing. The work query returns ids only: the FCR is
   * never read from a stored column.
   */
  function givenLiveBatches(verdictById: Record<string, FcrAtLastWeighing>): void {
    const entries = Object.entries(verdictById);
    managerQuery.mockResolvedValueOnce(entries.map(([id]) => ({ id })));
    calculateFcrAtLastWeighingMany.mockResolvedValueOnce(new Map(entries));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    getTargetFCRForBatches.mockImplementation(
      async (_tenantId: string, batchIds: string[]) =>
        new Map(batchIds.map((batchId) => [batchId, 1.5])),
    );
    analyzeFCRTrendMany.mockImplementation(
      async (_tenantId: string, batchIds: string[]) =>
        new Map(batchIds.map((batchId) => [batchId, { trend: 'declining' }])),
    );
  });

  it('emits warning (>%10) ve critical (>%20) — eşik altı batch event üretmez', async () => {
    givenLiveBatches({
      'b-warning': converting(1.72), // +14.7% → warning
      'b-ok': converting(1.55), // +3.3% → eşik altı
      'b-critical': converting(2.0), // +33.3% → critical
    });

    await service.sweepFcrForTenant(TENANT);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const events = enqueue.mock.calls.map((call) => call[0] as FCRAlertEvent);
    const warning = events.find((e) => e.batchId === 'b-warning');
    const critical = events.find((e) => e.batchId === 'b-critical');

    expect(warning).toMatchObject({
      eventType: 'FCRAlert',
      alertLevel: 'warning',
      currentFCR: 1.72,
      targetFCR: 1.5,
      trend: 'declining',
    });
    expect(warning!.variancePercent).toBeCloseTo(14.667, 3);
    expect(critical).toMatchObject({ alertLevel: 'critical', currentFCR: 2 });

    // FCR, hedef ve trend TEK toplu çağrıyla; trend yalnız eşiği aşan iki
    // batch için sorgulandı (FARM-LOW-291: batch başına round-trip yok).
    expect(calculateFcrAtLastWeighingMany).toHaveBeenCalledTimes(1);
    expect(calculateFcrAtLastWeighingMany).toHaveBeenCalledWith(TENANT, [
      'b-warning',
      'b-ok',
      'b-critical',
    ]);
    expect(analyzeFCRTrendMany).toHaveBeenCalledTimes(1);
    expect(analyzeFCRTrendMany).toHaveBeenCalledWith(TENANT, ['b-warning', 'b-critical']);
    expect(getTargetFCRForBatches).toHaveBeenCalledTimes(1);
    // Outbox aynı tenant-tx manager'ıyla yazıldı.
    expect(enqueue.mock.calls[0]![1]).toMatchObject({ query: managerQuery });
  });

  it('selects every live, feedable batch by lifecycle only, never by the stored fcr.actual', async () => {
    // FARM-CRITICAL-444: the stored column is 0 for every live batch, so a
    // work query gated on it selects nothing. The real-Postgres spec proves
    // the rows; this pins the shape the regression would take.
    managerQuery.mockResolvedValueOnce([]);

    await service.sweepFcrForTenant(TENANT);

    const [workQuery, params] = managerQuery.mock.calls[0] ?? [];
    expect(String(workQuery)).toContain('"isActive" = true');
    expect(String(workQuery)).not.toContain('fcr');
    // The status set is bound from the one owner assertFeedable reads, so a
    // fed PRE_HARVEST or HARVESTING batch is watched too.
    expect(params).toEqual([TENANT, [...OPERATIONAL_BATCH_STATUSES]]);
    expect(params?.[1]).toEqual(
      expect.arrayContaining([BatchStatus.PRE_HARVEST, BatchStatus.HARVESTING]),
    );
    expect(calculateFcrAtLastWeighingMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('judges only converting batches: unweighed, unfed and not-growing ones raise nothing', async () => {
    givenLiveBatches({
      'b-unweighed': { kind: 'unweighed' },
      'b-unfed': weighed('unfed', 0),
      'b-not-growing': { ...weighed('not-growing', 0), totalFeed: 30, totalGrowth: -1 },
      'b-1': converting(2.0),
    });

    await service.sweepFcrForTenant(TENANT);

    expect(getTargetFCRForBatches).toHaveBeenCalledWith(TENANT, ['b-1']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0]![0] as FCRAlertEvent).batchId).toBe('b-1');
  });

  it('hedefi P-14 zincirinden okur; hedef çözülemeyen batch atlanır', async () => {
    givenLiveBatches({ 'b-1': converting(2.0), 'b-no-target': converting(2.0) });
    getTargetFCRForBatches.mockImplementation(
      async (_tenantId: string, batchIds: string[]) =>
        new Map(batchIds.map((batchId) => [batchId, batchId === 'b-no-target' ? 0 : 1.5])),
    );

    await service.sweepFcrForTenant(TENANT);

    expect(getTargetFCRForBatches).toHaveBeenCalledWith(TENANT, ['b-1', 'b-no-target']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0]![0] as FCRAlertEvent).batchId).toBe('b-1');
  });

  it('hiç ihlal yoksa hiçbir event yazılmaz', async () => {
    givenLiveBatches({ 'b-ok': converting(1.5) });

    await service.sweepFcrForTenant(TENANT);

    expect(enqueue).not.toHaveBeenCalled();
    expect(analyzeFCRTrendMany).not.toHaveBeenCalled();
  });
});
