/**
 * Yeni tenant sessizce yemlemesiz açılamaz (FARM-MEDIUM-284).
 *
 * ## Karar: protokol TOHUMLANMAZ
 *
 * Plandaki b-2 maddesi "yeni tenant'a v2 protokol + atama tohumla" diyordu.
 * Bu, aynı programın kendi kuralıyla çelişir: taşınan protokollerde yemi
 * çözülemeyen bandlar DRAFT bırakılır, çünkü *"Draft'lar onaylanana dek plan
 * üretmez — sessiz tahmin YOK"*. Bir protokol tür-özel yetiştirme bilgisidir
 * (ağırlık bandları, oranlar, FCR, yem ürünleri); yeni bir tenant için
 * otomatik üretmek, biyolojiyi UYDURMAK olurdu ve mevcut durumdan DAHA
 * kötüsünü verirdi: balıklar tahmini oranlarla beslenir, kimse uyarılmaz.
 *
 * Ayrıca `FarmSeedService` kendi docblock'unda *"Do NOT use this service to
 * seed tenant schemas"* diyor — o servis KAYNAK şemayı (şablon) tohumlar.
 *
 * ## O hâlde garanti nedir
 *
 * "Balıklı ünitesi olan ama etkin planı olmayan tenant SESSİZ kalmaz."
 * Bu garanti bugün üç bağımsız parçanın rastlantısal uyumundan doğuyor:
 *
 *   1. tenant keşfi (`feedingTenants`) `tank_batches.totalQuantity > 0`
 *      olan tenant'ları da UNION'lıyor — yani hiç ataması olmayan tenant da
 *      cron'a giriyor;
 *   2. `generateForTenant` atama döngüsünden SONRA `detectUnfedUnits` çağırıyor
 *      (döngü boş olsa bile çalışıyor);
 *   3. sorgunun CASE'inde `no_assignment` kolu var.
 *
 * Üçünden herhangi biri sessizce değişirse tenant yine kör kalır ve bunu
 * hiçbir test yakalamıyordu. Bu spec o zinciri pinler.
 */
const managerFind = jest.fn();
const managerQuery = jest.fn();
const runnerQuery = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  listTenantSchemas: jest.fn().mockResolvedValue(['tenant_aaaa']),
  runInTenantTransaction: (
    _ds: unknown,
    _schema: string,
    _tenantId: string,
    cb: (qr: { manager: unknown }) => Promise<void>,
  ) => cb({ manager: { find: managerFind, query: managerQuery } }),
}));

import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent, UnfedUnitDetectedEvent } from '@platform/event-contracts';

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
const UNIT = '77777777-7777-4777-8777-777777777777';

/**
 * Yeni tenant'ın hâli: stoklanmış bir tank var, HİÇ atama yok, hiç plan yok.
 */
interface NewTenantFixture {
  stockedUnits: number;
}

function makeHarness(fixture: NewTenantFixture) {
  const enqueued: BaseEvent[] = [];

  // Atama sayfası her zaman boş — tenant'ın hiç ataması yok.
  managerFind.mockResolvedValue([]);

  managerQuery.mockImplementation(async (sql: string) => {
    // `detectUnfedUnits` sorgusunu sahte Postgres olarak yanıtla: yalnız
    // `tank_batches` üzerinden balıklı ünite arayan sorgu satır döndürür.
    if (String(sql).includes('tank_batches') && String(sql).includes('no_assignment')) {
      return Array.from({ length: fixture.stockedUnits }, (_unused, index) => ({
        unitId: `${UNIT}-${index}`,
        unitCode: `T-${index}`,
        siteId: '88888888-8888-4888-8888-888888888888',
        fishCount: 1000,
        biomassKg: 100,
        reason: 'no_assignment',
      }));
    }
    return [];
  });

  const growthApplier = stub<BiomassGrowthApplierService>({});
  const outboxPublisher = stub<OutboxPublisher>({
    enqueue: jest.fn(async (event: BaseEvent) => {
      enqueued.push(event);
      return undefined as never;
    }),
  });
  const recalcService = stub<DayPlanRecalcService>({});

  const service = new FeedingCronV2Service(
    stub<DataSource>({
      createQueryRunner: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        query: runnerQuery,
        release: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    stub<MealPlanGeneratorService>({ persistDayPlan: jest.fn() }),
    growthApplier,
    stub<WaterTemperatureService>({
      getEffectiveTemperaturesForUnits: jest.fn().mockResolvedValue(new Map()),
    }),
    stub<FCRCalculationService>({}),
    outboxPublisher,
    stub<ProtocolFeedForecastService>({}),
    recalcService,
    realFinalizationService({ growthApplier, recalcService, outboxPublisher }),
    stub<FeedingClockService>({
      siteZones: jest.fn().mockResolvedValue({ tenantZone: 'UTC', zoneOf: () => 'UTC' }),
    }),
    stub<FeedingJobRunService>({}),
  );
  return { service, enqueued };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Yeni tenant — balıklı ama atamasız ünite sessiz kalmaz (FARM-MEDIUM-284)', () => {
  it('atama HİÇ yokken bile üretim koşusu UnfedUnitDetected(no_assignment) yayar', async () => {
    const h = makeHarness({ stockedUnits: 1 });

    await h.service.generateForTenant(TENANT);

    const unfed = h.enqueued.filter(
      (event): event is UnfedUnitDetectedEvent => event.eventType === 'UnfedUnitDetected',
    );
    expect(unfed).toHaveLength(1);
    expect(unfed[0]!.reason).toBe('no_assignment');
    expect(unfed[0]!.fishCount).toBe(1000);
  });

  it('tespit, atama döngüsünden BAĞIMSIZ koşar — boş sayfa erken çıkışı onu atlayamaz', async () => {
    // Döngü ilk boş sayfada `break` ediyor; tespit ondan SONRA gelmeli.
    // Sıra bozulursa (tespit döngünün içine taşınırsa) atamasız tenant hiçbir
    // şey yaymaz — kusurun geri dönüş biçimi tam olarak budur.
    const h = makeHarness({ stockedUnits: 3 });

    await h.service.generateForTenant(TENANT);

    expect(managerFind).toHaveBeenCalled();
    expect(h.enqueued.filter((event) => event.eventType === 'UnfedUnitDetected')).toHaveLength(3);
  });

  it('tenant keşfi, ataması olmayan ama stoklanmış tenant’ı da bulur', async () => {
    // Keşif UNION'ından `tank_batches` kolu düşerse yeni tenant cron'a HİÇ
    // girmez ve yukarıdaki tespit de hiç koşmaz.
    const h = makeHarness({ stockedUnits: 1 });
    runnerQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SET search_path')) return [];
      return String(sql).includes('tank_batches') ? [{ tenantId: TENANT }] : [];
    });

    const tenants = await h.service.feedingTenants();

    expect(tenants).toContain(TENANT);
  });
});
