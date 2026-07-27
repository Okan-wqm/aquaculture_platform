/**
 * 18:00 FCR alert süpürmesi (C-1) — İLK durable FCRAlert emisyonu.
 *
 * Pinlenen sözleşme:
 *  - Eşikler legacy analyzeFCR ile birebir: varyans >%10 warning, >%20
 *    critical; eşik altı batch event üretmez.
 *  - Hedef P-14 zincirinden okunur (FCRCalculationService.getTargetFCRForBatch)
 *    — batch.fcr.target kopyası değil.
 *  - Trend YALNIZ eşiği aşan batch'ler için sorgulanır (ölçek disiplini).
 *  - Event outbox'a AYNI tenant transaction manager'ıyla yazılır.
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
import { FeedingJobRunService } from '../services/feeding-job-run.service';
import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import type { FCRAlertEvent } from '@platform/event-contracts';

const TENANT = '11111111-1111-4111-8111-111111111111';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('FeedingCronV2Service.sweepFcrForTenant (C-1)', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  // W5 (FARM-LOW-286): süpürme artık batch başına değil TOPLU okur.
  const getTargetFCRForBatches = jest.fn();
  const analyzeFCRTrendMany = jest.fn();

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    mock<MealPlanGeneratorService>({}),
    mock<BiomassGrowthApplierService>({}),
    mock<WaterTemperatureService>({}),
    mock<FCRCalculationService>({ getTargetFCRForBatches, analyzeFCRTrendMany }),
    mock<OutboxPublisher>({ enqueue }),
    mock<ProtocolFeedForecastService>({}),
    mock<DayPlanRecalcService>({ recalcForUnit: jest.fn() }),
    mock<FeedingClockService>({}),
    mock<FeedingJobRunService>({}),
  );

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
    managerQuery.mockResolvedValueOnce([
      { id: 'b-warning', actual: 1.72 }, // +14.7% → warning
      { id: 'b-ok', actual: 1.55 }, // +3.3% → eşik altı
      { id: 'b-critical', actual: 2.0 }, // +33.3% → critical
    ]);

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

    // Trend TEK toplu çağrıyla ve yalnız eşiği aşan iki batch için sorgulandı
    // (FARM-LOW-286: batch başına round-trip yok).
    expect(analyzeFCRTrendMany).toHaveBeenCalledTimes(1);
    expect(analyzeFCRTrendMany).toHaveBeenCalledWith(TENANT, ['b-warning', 'b-critical']);
    expect(getTargetFCRForBatches).toHaveBeenCalledTimes(1);
    // Outbox aynı tenant-tx manager'ıyla yazıldı.
    expect(enqueue.mock.calls[0]![1]).toMatchObject({ query: managerQuery });
  });

  it('hedefi P-14 zincirinden okur; hedef çözülemeyen batch atlanır', async () => {
    managerQuery.mockResolvedValueOnce([
      { id: 'b-1', actual: 2.0 },
      { id: 'b-no-target', actual: 2.0 },
    ]);
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
    managerQuery.mockResolvedValueOnce([{ id: 'b-ok', actual: 1.5 }]);

    await service.sweepFcrForTenant(TENANT);

    expect(enqueue).not.toHaveBeenCalled();
    expect(analyzeFCRTrendMany).not.toHaveBeenCalled();
  });
});
