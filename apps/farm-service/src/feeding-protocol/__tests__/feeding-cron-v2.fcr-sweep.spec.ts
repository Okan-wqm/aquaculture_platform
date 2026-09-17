/**
 * 18:00 FCR alert süpürmesi (C-1) — ALARM POLİTİKASI sözleşmesi.
 *
 * KAPSAM UYARISI (bilinçli): bu dosya artık YALNIZ eşik/hedef/outbox
 * politikasını doğrular. Süpürmenin HANGİ batch'leri gördüğü ve yürüyen FCR'ın
 * nasıl hesaplanıp `batches_v2.fcr.actual`'a projekte edildiği burada MOCK'tur
 * ve buradan doğrulanamaz — o kontrat gerçek Postgres'e karşı
 * `src/__tests__/e2e/running-fcr-sweep.postgres.spec.ts` içinde koşar.
 *
 * Bu ayrım kasıtlıdır: bu dosyanın eski hâli `manager.query`'yi mock'layıp
 * satırları doğrudan döndürüyordu, yani ASLA yüklemi çalıştırmadı. Süpürme
 * aylarca ölüyken bu testler yeşil kaldı. Bir testin doğruladığını iddia ettiği
 * şeyi mock'laması, testin olmamasından kötüdür.
 *
 * Pinlenen sözleşme:
 *  - Eşikler legacy analyzeFCR ile birebir: varyans >%10 warning, >%20
 *    critical; eşik altı batch event üretmez.
 *  - Hesaplanan FCR 0 ise (gerçekleşmiş büyüme yok) event YOK — "mükemmel
 *    dönüşüm" değil, "ölçülecek veri yok" demektir.
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
import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  FCRCalculationService,
  type RunningFcr,
} from '../../growth/services/fcr-calculation.service';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import type { FCRAlertEvent } from '@platform/event-contracts';

const TENANT = '11111111-1111-4111-8111-111111111111';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

/** Tek satırlık yürüyen-FCR kaydı — feed/growth alanları politika için ilgisiz. */
function running(batchId: string, fcr: number): RunningFcr {
  return { batchId, fcr, totalFeed: 0, totalGrowth: 0 };
}

describe('FeedingCronV2Service.sweepFcrForTenant (C-1)', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const getTargetFCRForBatch = jest.fn();
  const analyzeFCRTrend = jest.fn();
  /**
   * Gerçek `refreshRunningFcrForTenant`'ın sözleşmesini taklit eder: her canlı
   * batch için callback'i çağırır, sonra listeyi döner. Callback'i ÇAĞIRMASI
   * kritiktir — alarm politikası tam olarak orada koşar.
   */
  const refreshRunningFcrForTenant = jest.fn(
    async (
      _manager: unknown,
      _tenantId: string,
      _computedAt: Date,
      onBatch: (entry: RunningFcr) => Promise<void>,
    ): Promise<RunningFcr[]> => {
      for (const entry of currentRunning) {
        await onBatch(entry);
      }
      return currentRunning;
    },
  );
  let currentRunning: RunningFcr[] = [];

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    mock<MealPlanGeneratorService>({}),
    mock<BiomassGrowthApplierService>({}),
    mock<WaterTemperatureService>({}),
    mock<FCRCalculationService>({
      getTargetFCRForBatch,
      analyzeFCRTrend,
      refreshRunningFcrForTenant,
    }),
    mock<OutboxPublisher>({ enqueue }),
    mock<ProtocolFeedForecastService>({}),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    currentRunning = [];
    getTargetFCRForBatch.mockResolvedValue(1.5);
    analyzeFCRTrend.mockResolvedValue({ trend: 'declining' });
  });

  it('emits warning (>%10) ve critical (>%20) — eşik altı batch event üretmez', async () => {
    currentRunning = [
      running('b-warning', 1.72), // +14.7% → warning
      running('b-ok', 1.55), // +3.3% → eşik altı
      running('b-critical', 2.0), // +33.3% → critical
    ];

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
    currentRunning = [running('b-1', 2.0), running('b-no-target', 2.0)];
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
    currentRunning = [running('b-ok', 1.5)];

    await service.sweepFcrForTenant(TENANT);

    expect(enqueue).not.toHaveBeenCalled();
    expect(analyzeFCRTrend).not.toHaveBeenCalled();
  });

  it('FCR 0 olan canlı batch alarm üretmez ve hedef bile sorgulanmaz', async () => {
    // Henüz gerçekleşmiş büyümesi olmayan taze batch. Eski kod bunu SQL'de
    // `> 0` ile eliyordu; şart artık bu turda HESAPLANAN değere uygulanıyor.
    // Aksi hâlde varyans -%100 çıkar ve "mükemmel FCR" gibi okunurdu.
    currentRunning = [running('b-fresh', 0)];

    await service.sweepFcrForTenant(TENANT);

    expect(enqueue).not.toHaveBeenCalled();
    expect(getTargetFCRForBatch).not.toHaveBeenCalled();
    expect(analyzeFCRTrend).not.toHaveBeenCalled();
  });

  it('yürüyen FCR yenilemesi tenant-tx manager ve tek zaman damgasıyla çağrılır', async () => {
    currentRunning = [running('b-1', 1.2)];

    await service.sweepFcrForTenant(TENANT);

    expect(refreshRunningFcrForTenant).toHaveBeenCalledTimes(1);
    const [manager, tenantId, computedAt] = refreshRunningFcrForTenant.mock.calls[0]!;
    expect(manager).toMatchObject({ query: managerQuery });
    expect(tenantId).toBe(TENANT);
    expect(computedAt).toBeInstanceOf(Date);
  });
});
