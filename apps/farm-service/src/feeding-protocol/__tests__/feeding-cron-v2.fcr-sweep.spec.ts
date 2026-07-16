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
  const getTargetFCRForBatch = jest.fn();
  const analyzeFCRTrend = jest.fn();

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    mock<MealPlanGeneratorService>({}),
    mock<BiomassGrowthApplierService>({}),
    mock<WaterTemperatureService>({}),
    mock<FCRCalculationService>({ getTargetFCRForBatch, analyzeFCRTrend }),
    mock<OutboxPublisher>({ enqueue }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    getTargetFCRForBatch.mockResolvedValue(1.5);
    analyzeFCRTrend.mockResolvedValue({ trend: 'declining' });
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

    // Trend yalnız eşiği aşan iki batch için sorgulandı.
    expect(analyzeFCRTrend).toHaveBeenCalledTimes(2);
    // Outbox aynı tenant-tx manager'ıyla yazıldı.
    expect(enqueue.mock.calls[0]![1]).toMatchObject({ query: managerQuery });
  });

  it('hedefi P-14 zincirinden okur; hedef çözülemeyen batch atlanır', async () => {
    managerQuery.mockResolvedValueOnce([
      { id: 'b-1', actual: 2.0 },
      { id: 'b-no-target', actual: 2.0 },
    ]);
    getTargetFCRForBatch.mockImplementation(async (batchId: string) =>
      batchId === 'b-no-target' ? 0 : 1.5,
    );

    await service.sweepFcrForTenant(TENANT);

    expect(getTargetFCRForBatch).toHaveBeenCalledWith('b-1');
    expect(getTargetFCRForBatch).toHaveBeenCalledWith('b-no-target');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0]![0] as FCRAlertEvent).batchId).toBe('b-1');
  });

  it('hiç ihlal yoksa hiçbir event yazılmaz', async () => {
    managerQuery.mockResolvedValueOnce([{ id: 'b-ok', actual: 1.5 }]);

    await service.sweepFcrForTenant(TENANT);

    expect(enqueue).not.toHaveBeenCalled();
    expect(analyzeFCRTrend).not.toHaveBeenCalled();
  });
});
