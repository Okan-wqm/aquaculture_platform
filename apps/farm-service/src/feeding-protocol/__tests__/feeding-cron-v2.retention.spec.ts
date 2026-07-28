/**
 * Aylık retention temizliği (K-16 + NFR "Receipt büyümesi").
 *
 * Pinlenen sözleşme:
 *  - Day plan + öğünler 24 AY, mobil komut makbuzları 90 GÜN pencereleriyle
 *    silinir (pencere sabitleri SQL'e gömülür — sessizce değişemez).
 *  - Silme sırası: önce öğünler (plan join'i), sonra planlar — yarıda kesilen
 *    koşu öksüz öğün bırakamaz.
 *  - Her silme tenant filtrelidir ve AYNI tenant transaction'ında koşar.
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
import { realFinalizationService } from './helpers/meal-finalization-double';
import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

const TENANT = '11111111-1111-4111-8111-111111111111';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('FeedingCronV2Service.purgeTenantRetention', () => {
  const growthApplier = mock<BiomassGrowthApplierService>({});
  const outboxPublisher = mock<OutboxPublisher>({ enqueue: jest.fn() });
  const recalcService = mock<DayPlanRecalcService>({ recalcForUnit: jest.fn() });

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    mock<MealPlanGeneratorService>({}),
    growthApplier,
    mock<WaterTemperatureService>({}),
    mock<FCRCalculationService>({}),
    outboxPublisher,
    mock<ProtocolFeedForecastService>({}),
    recalcService,
    realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
    mock<FeedingClockService>({}),
    mock<FeedingJobRunService>({ purgeOlderThanRetention: jest.fn().mockResolvedValue(0) }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    managerQuery.mockResolvedValue([{ count: 0 }]);
  });

  it('24 ay / 30 gün / 90 gün pencereleriyle, öğün → plan → forecast → makbuz sırasında siler', async () => {
    await service.purgeTenantRetention(TENANT);

    expect(managerQuery).toHaveBeenCalledTimes(4);
    const sqls = managerQuery.mock.calls.map((call) => String(call[0]));

    // Sıra: öğünler (plan join'i) → planlar → forecast kapsamları → makbuzlar.
    expect(sqls[0]).toContain('DELETE FROM "feeding_meals"');
    expect(sqls[0]).toContain('USING "feeding_day_plans"');
    expect(sqls[0]).toContain("INTERVAL '24 months'");
    expect(sqls[1]).toContain('DELETE FROM "feeding_day_plans"');
    expect(sqls[1]).toContain("INTERVAL '24 months'");
    // W6 (FARM-LOW-296): artık YENİLENMEYEN forecast kapsamları — canlı
    // budama servis tarafında, bu yalnız ölü satır süpürmesidir.
    expect(sqls[2]).toContain('DELETE FROM "feeding_forecast_snapshots"');
    expect(sqls[2]).toContain("INTERVAL '30 days'");
    expect(sqls[3]).toContain('DELETE FROM "farm_mobile_command_receipts"');
    expect(sqls[3]).toContain("INTERVAL '90 days'");

    // Her silme tenant parametresiyle koşar.
    for (const call of managerQuery.mock.calls) {
      expect(call[1]).toEqual([TENANT]);
    }
  });
});
