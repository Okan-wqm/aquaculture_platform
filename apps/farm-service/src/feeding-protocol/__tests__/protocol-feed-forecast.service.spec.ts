/**
 * ProtocolFeedForecastService golden testleri (plan Doğrulama #5).
 *
 * Bilinen fixture: geçişli protokol (A→B bandı), sınırlı stok — beklenen
 * stockoutDate / coverageFromAdoption / geçiş-kapsama açığı değerleri ELLE
 * hesaplanıp pinlenir. Motorla aynı ProtocolRateService kullanıldığı için
 * bu sayılar aynı zamanda fiili yürütmenin de projeksiyonudur.
 *
 * Sabit büyüme matematiği (rate %2, FCR 1.0, sıcaklık yok):
 *   biomass_d = 800 × 1.02^d  →  avgW gün 12'de 100g bandını aşar (A→B geçişi).
 *   A stoğu 100kg: kümülatif tüketim gün 5'te 100'ü aşar → stockoutDay 5.
 *   B stoğu 50kg: ilk tüketim gün 12, kümülatif gün 14'te 50'yi aşar →
 *   coverageFromAdoption = 2 ("B 2 gün yeter"); leadTime(feed)=3 →
 *   gerekli kapsama 12+3=15 > 14 → TRANSITION_COVERAGE_GAP days=1.
 */
import { ProtocolFcrSource } from '../entities/feeding-protocol-v2.entity';
import { ProtocolRateService } from '../services/protocol-rate.service';
import {
  dailySurvivalRateFromCyclePercent,
  ForecastFeedInput,
  ForecastUnitInput,
  NOMINAL_CYCLE_DAYS,
  ProtocolFeedForecastService,
  TENANT_SCOPE_KEY,
} from '../services/protocol-feed-forecast.service';

const FEED_A = '11111111-1111-4111-8111-111111111111';
const FEED_B = '22222222-2222-4222-8222-222222222222';
const SITE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_NO_STORAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-01-01';

function makeService(): ProtocolFeedForecastService {
  return new ProtocolFeedForecastService(
    undefined as never,
    new ProtocolRateService(),
    undefined as never,
    undefined as never,
  );
}

function protocolFixture(): ForecastUnitInput['protocol'] {
  return {
    bands: [
      {
        minWeightG: 0,
        maxWeightG: 100,
        feedId: FEED_A,
        feedCode: 'A',
        feedName: 'Feed A',
        feedingRatePercent: 2,
        expectedFcr: 1.0,
      },
      {
        minWeightG: 100,
        maxWeightG: 100000,
        feedId: FEED_B,
        feedCode: 'B',
        feedName: 'Feed B',
        feedingRatePercent: 2,
        expectedFcr: 1.0,
      },
    ],
    temperatureAdjustments: [],
    settings: {
      autoTransition: true,
      transitionBufferG: 0,
      growthApplicationMode: 'per_meal',
      underfeedAlertThresholdPercent: 15,
      fcrSource: ProtocolFcrSource.BAND,
    },
    fcrMatrix: undefined,
  };
}

function unitFixture(overrides: Partial<ForecastUnitInput> = {}): ForecastUnitInput {
  return {
    unitId: 'unit-1',
    unitName: 'Tank 1',
    unitCode: 'T1',
    scopeKey: SITE_1,
    avgWeightG: 80,
    fishCount: 10000,
    biomassKg: 800,
    temperatureC: null,
    protocol: protocolFixture(),
    dailySurvivalRate: 1.0,
    ...overrides,
  };
}

function feedFixtures(): ForecastFeedInput[] {
  return [
    {
      feedId: FEED_A,
      feedCode: 'A',
      feedName: 'Feed A',
      stockKgByScope: new Map([
        [SITE_1, 100],
        [TENANT_SCOPE_KEY, 100],
      ]),
      procurementLeadTimeDays: null, // → default 7, leadTimeSource 'default'
    },
    {
      feedId: FEED_B,
      feedCode: 'B',
      feedName: 'Feed B',
      stockKgByScope: new Map([
        [SITE_1, 50],
        [TENANT_SCOPE_KEY, 50],
      ]),
      procurementLeadTimeDays: 3, // → leadTimeSource 'feed'
    },
  ];
}

describe('dailySurvivalRateFromCyclePercent (§5 saf indirgeme — FARM-MEDIUM-225)', () => {
  it('döngü-toplamı %90 → (0.9)^(1/NOMINAL_CYCLE_DAYS) günlük çarpan', () => {
    const rate = dailySurvivalRateFromCyclePercent(90);
    expect(rate).toBeCloseTo(Math.pow(0.9, 1 / NOMINAL_CYCLE_DAYS), 10);
    expect(rate).toBeLessThan(1);
    expect(rate).toBeGreaterThan(0.999);
  });

  it('%100 → tam 1.0 (ölümsüzle aynı etki, mortalityAssumption uygulanmamış kalır)', () => {
    expect(dailySurvivalRateFromCyclePercent(100)).toBe(1);
  });

  it.each([undefined, null, 'yüzde', 0, -5, 150, Number.NaN])(
    'aralık dışı/tanımsız girdi (%p) null döner — çağıran muhafazakâr 1.0 varsayımına düşer',
    (value) => {
      expect(dailySurvivalRateFromCyclePercent(value)).toBeNull();
    },
  );
});

describe('ProtocolFeedForecastService.computeForecast (golden)', () => {
  const service = makeService();
  const result = service.computeForecast({
    units: [unitFixture()],
    feeds: feedFixtures(),
    horizonDays: 60,
    startDate: START,
  });
  const scope = result.find((r) => r.scopeKey === SITE_1);

  it('A→B band geçişini 12. günde işaretler ve currentFeed B olur', () => {
    const unit = scope?.perUnit.find((u) => u.unitId === 'unit-1');
    expect(unit?.transitions).toEqual([
      { fromFeedId: FEED_A, toFeedId: FEED_B, estimatedDate: '2026-01-13', daysFromNow: 12 },
    ]);
    expect(unit?.currentFeedId).toBe(FEED_B);
  });

  it('A yemi: stockout gün 5, coverageFromAdoption 5, default leadTime provenanslı', () => {
    const feedA = scope?.perFeed.find((f) => f.feedId === FEED_A);
    expect(feedA?.daysOfCover).toBe(5);
    expect(feedA?.stockoutDate).toBe('2026-01-06');
    expect(feedA?.firstConsumptionDate).toBe(START);
    expect(feedA?.coverageFromAdoptionDays).toBe(5);
    expect(feedA?.procurementLeadTimeDays).toBe(7);
    expect(feedA?.leadTimeSource).toBe('default');
    // Tükeniş (5) − leadTime (7) geçmişte kalır → bugüne clamp'lenir.
    expect(feedA?.reorderDate).toBe(START);
    expect(feedA?.reorderQuantityKg ?? 0).toBeGreaterThan(0);
  });

  it('B yemi: benimsemeden tükenişe 2 gün ("B 2 gün yeter") ve seri grafik-hazır', () => {
    const feedB = scope?.perFeed.find((f) => f.feedId === FEED_B);
    expect(feedB?.firstConsumptionDate).toBe('2026-01-13');
    expect(feedB?.daysOfCover).toBe(14);
    expect(feedB?.coverageFromAdoptionDays).toBe(2);
    expect(feedB?.leadTimeSource).toBe('feed');
    expect(feedB?.dailyConsumptionSeries).toHaveLength(60);
    expect(feedB?.remainingStockSeries).toHaveLength(60);
    // Gün 11'e kadar tüketim yok, stok dokunulmamış kalır.
    expect(feedB?.dailyConsumptionSeries[11]).toBe(0);
    expect(feedB?.remainingStockSeries[11]).toBe(50);
  });

  it('alertler: A için STOCKOUT+REORDER_NOW, B için ünite bazlı kapsama açığı (1 gün)', () => {
    expect(scope?.alerts).toEqual(
      expect.arrayContaining([
        { type: 'STOCKOUT_FORECAST', feedId: FEED_A, days: 5 },
        { type: 'REORDER_NOW', feedId: FEED_A, days: 5 },
        { type: 'STOCKOUT_FORECAST', feedId: FEED_B, days: 14 },
        { type: 'TRANSITION_COVERAGE_GAP', feedId: FEED_B, unitId: 'unit-1', days: 1 },
      ]),
    );
  });

  it('ölümsüz varsayım açıkça işaretlenir (source: none)', () => {
    expect(scope?.mortalityAssumption).toEqual({ applied: false, source: 'none' });
  });
});

describe('ProtocolFeedForecastService.computeForecast (kapsam + ölüm projeksiyonu)', () => {
  const service = makeService();

  it("depolamasız site tenant-geneli fallback kapsamına düşer (D-9, scopeKey 'tenant')", () => {
    const results = service.computeForecast({
      units: [
        unitFixture(),
        unitFixture({ unitId: 'unit-2', unitCode: 'T2', scopeKey: TENANT_SCOPE_KEY }),
      ],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    const scopeKeys = results.map((r) => r.scopeKey).sort();
    expect(scopeKeys).toEqual([SITE_1, TENANT_SCOPE_KEY].sort());
    const tenantScope = results.find((r) => r.scopeKey === TENANT_SCOPE_KEY);
    expect(tenantScope?.perFeed.find((f) => f.feedId === FEED_A)?.currentStockKg).toBe(100);
    expect(tenantScope?.perUnit.map((u) => u.unitId)).toEqual(['unit-2']);
  });

  it('hayatta-kalma oranı uygulanınca tüketim düşer ve varsayım işaretlenir', () => {
    const [withMortality] = service.computeForecast({
      units: [unitFixture({ dailySurvivalRate: 0.99 })],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    const [without] = service.computeForecast({
      units: [unitFixture()],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    expect(withMortality?.mortalityAssumption).toEqual({
      applied: true,
      source: 'species_survival_rate',
    });
    const consumedWith = withMortality?.perFeed
      .flatMap((f) => f.dailyConsumptionSeries)
      .reduce((a, b) => a + b, 0);
    const consumedWithout = without?.perFeed
      .flatMap((f) => f.dailyConsumptionSeries)
      .reduce((a, b) => a + b, 0);
    expect(consumedWith ?? 0).toBeLessThan(consumedWithout ?? Infinity);
  });

  it('hasat kesintisi ünite tüketimini o günden itibaren azaltır (C-14 saf girdi)', () => {
    const [withHarvest] = service.computeForecast({
      units: [unitFixture({ harvestFractionByDay: new Map([[3, 1]]) })],
      feeds: feedFixtures(),
      horizonDays: 10,
      startDate: START,
    });
    const feedA = withHarvest?.perFeed.find((f) => f.feedId === FEED_A);
    // Tam hasat gün 3'te: gün 3 ve sonrası tüketim sıfır.
    expect(feedA?.dailyConsumptionSeries[2] ?? 0).toBeGreaterThan(0);
    expect(feedA?.dailyConsumptionSeries[3]).toBe(0);
    expect(feedA?.daysOfCover).toBeNull();
  });
});
