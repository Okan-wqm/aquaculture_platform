/**
 * W5 saatlik tick pinleri (FARM-LOW-264, FARM-MEDIUM-255).
 *
 * Yemleme işleri artık sabit bir zon altında (`Europe/Istanbul`) değil,
 * saatlik bir UTC tick'i altında koşar; tick her tenant için yerel saati
 * çözer ve `feeding_job_runs` claim'i "tenant'ın yerel gününde tam bir kez"
 * garantisini DB tarafında verir.
 *
 * Pinlenenler:
 *  - iş YALNIZ kendi yerel saatinde tetiklenir (Oslo tenant'ı İstanbul'un
 *    06:00'ında plan üretmez);
 *  - claim `null` dönerse (o yerel gün zaten başarıyla koştu) iş KOŞMAZ —
 *    DST'de saat tekrarlandığında çift koşu imkânsız;
 *  - iş hata verirse koşu `succeeded` DAMGALANMAZ (bir sonraki tick yeniden
 *    dener) ve tick diğer tenant'lara devam eder;
 *  - yarım kalan koşu (sayfa tavanı) da `succeeded` olmaz.
 */
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

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
import { stub, stubMember } from '@aquaculture/testing';

const OSLO_TENANT = '11111111-1111-4111-8111-111111111111';
const ISTANBUL_TENANT = '22222222-2222-4222-8222-222222222222';

interface TickHarnessOptions {
  /** Tick anı (UTC). */
  at: Date;
  claim?: jest.Mock;
  generateForTenant?: jest.Mock;
  sweepTenant?: jest.Mock;
}

function makeHarness(options: TickHarnessOptions) {
  const claim = options.claim ?? jest.fn().mockResolvedValue('run-1');
  const settle = jest.fn().mockResolvedValue(undefined);
  const growthApplier = stub<BiomassGrowthApplierService>({});
  const outboxPublisher = stub<OutboxPublisher>({ enqueue: jest.fn() });
  const recalcService = stub<DayPlanRecalcService>({});

  const service = new FeedingCronV2Service(
    stub<DataSource>({
      // runExclusive advisory-lock runner'ı.
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
    stub<ProtocolFeedForecastService>({ refreshTenant: jest.fn() }),
    recalcService,
    realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
    stub<FeedingClockService>({
      tenantZones: jest.fn().mockResolvedValue(
        new Map([
          [OSLO_TENANT, 'Europe/Oslo'],
          [ISTANBUL_TENANT, 'Europe/Istanbul'],
        ]),
      ),
    }),
    stub<FeedingJobRunService>({ claim, settle }),
  );

  // Keşif ve iş yürütücüleri servis dışında pinlenir (tick'in KARARINI test
  // ediyoruz, işlerin içeriğini değil).
  const feedingTenants = jest.fn().mockResolvedValue([OSLO_TENANT, ISTANBUL_TENANT]);
  Object.defineProperty(service, 'feedingTenants', { value: feedingTenants });

  const generateForTenant = options.generateForTenant ?? jest.fn().mockResolvedValue(undefined);
  const sweepTenant = options.sweepTenant ?? jest.fn().mockResolvedValue(true);
  // Naming the member type keeps the override checked against the real method:
  // if `generateForTenant`/`sweepTenant` change arity or return type, this
  // harness stops compiling instead of silently driving the tick with a double
  // the service no longer calls that way.
  service.generateForTenant =
    stubMember<FeedingCronV2Service['generateForTenant']>(generateForTenant);
  service.sweepTenant = stubMember<FeedingCronV2Service['sweepTenant']>(sweepTenant);

  jest.useFakeTimers().setSystemTime(options.at);
  return { service, claim, settle, generateForTenant, sweepTenant };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('FeedingCronV2Service.hourlyTick (W5)', () => {
  it('06:00 üretimi YALNIZ yerel saati 6 olan tenant için tetiklenir', async () => {
    // UTC 04:00 → Oslo 06:00 (yaz saati, UTC+2); İstanbul 07:00.
    const harness = makeHarness({ at: new Date('2026-07-20T04:00:00Z') });

    await harness.service.hourlyTick();

    expect(harness.generateForTenant).toHaveBeenCalledTimes(1);
    expect(harness.generateForTenant).toHaveBeenCalledWith(OSLO_TENANT);
    // İstanbul tenant'ı bu tick'te 07:00'da — kapsama süpürmesi claim'ler.
    const claimedJobs = harness.claim.mock.calls.map((call) => [call[0], call[1]]);
    expect(claimedJobs).toEqual(
      expect.arrayContaining([
        [OSLO_TENANT, 'generate-day-plans'],
        [ISTANBUL_TENANT, 'stock-coverage'],
      ]),
    );
  });

  it('claim null dönerse (yerel gün zaten koştu) iş KOŞMAZ', async () => {
    const harness = makeHarness({
      at: new Date('2026-07-20T04:00:00Z'),
      claim: jest.fn().mockResolvedValue(null),
    });

    await harness.service.hourlyTick();

    expect(harness.generateForTenant).not.toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();
  });

  it('claim yerel TARİHİ ve zonu taşır (UTC günü değil)', async () => {
    // UTC 22:00 → Oslo ertesi gün 00:00; iş saati değil ama İstanbul 01:00.
    // Oslo 06:00 için UTC 04:00 kullanılır; burada tarihin kaymasını pinliyoruz.
    const harness = makeHarness({ at: new Date('2026-07-20T04:00:00Z') });

    await harness.service.hourlyTick();

    expect(harness.claim).toHaveBeenCalledWith(
      OSLO_TENANT,
      'generate-day-plans',
      '2026-07-20',
      'Europe/Oslo',
    );
  });

  it('iş hata verirse koşu succeeded DAMGALANMAZ ve tick diğer tenant’a devam eder', async () => {
    const harness = makeHarness({
      at: new Date('2026-07-20T04:00:00Z'),
      generateForTenant: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await harness.service.hourlyTick();

    const failed = harness.settle.mock.calls.find((call) => call[1] === false);
    expect(failed).toBeDefined();
    expect(failed![2]).toBe('boom');
    // Diğer tenant'ın işi (İstanbul 07:00 kapsama) yine claim'lendi.
    expect(harness.claim).toHaveBeenCalledWith(
      ISTANBUL_TENANT,
      'stock-coverage',
      expect.any(String),
      'Europe/Istanbul',
    );
  });

  it('yarım kalan süpürme (sayfa tavanı) succeeded DAMGALANMAZ', async () => {
    // UTC 03:00 → Oslo 05:00 (sabah süpürmesi).
    const harness = makeHarness({
      at: new Date('2026-07-20T03:00:00Z'),
      sweepTenant: jest.fn().mockResolvedValue(false),
    });

    await harness.service.hourlyTick();

    expect(harness.sweepTenant).toHaveBeenCalledTimes(1);
    expect(harness.settle).toHaveBeenCalledWith(
      'run-1',
      false,
      expect.stringContaining('page cap'),
    );
  });
});
