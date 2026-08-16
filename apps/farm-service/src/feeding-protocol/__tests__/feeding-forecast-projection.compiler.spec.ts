/**
 * FeedingForecastProjectionCompiler golden testleri (plan Doğrulama #5).
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
  FeedingForecastProjectionCompiler,
  ForecastFeedInput,
  ForecastUnitInput,
  NOMINAL_CYCLE_DAYS,
  TENANT_SCOPE_KEY,
} from '../executors/protocol-feed-forecast.executor';

const FEED_A = '11111111-1111-4111-8111-111111111111';
const FEED_B = '22222222-2222-4222-8222-222222222222';
const SITE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_NO_STORAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-01-01';

function makeCompiler(): FeedingForecastProjectionCompiler {
  return new FeedingForecastProjectionCompiler(new ProtocolRateService());
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
    siteId: SITE_1,
    hasLocalStorage: true,
    avgWeightG: 80,
    fishCount: 10000,
    biomassKg: 800,
    temperatureC: null,
    protocol: protocolFixture(),
    mortality: { source: 'none', dailySurvivalRate: 1 },
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

  it('%100 → tam 1.0 (hesap etkisi yoktur, kaynak provenansı yine korunabilir)', () => {
    expect(dailySurvivalRateFromCyclePercent(100)).toBe(1);
  });

  it.each([undefined, null, 'yüzde', 0, -5, 150, Number.NaN])(
    'aralık dışı/tanımsız girdi (%p) null döner — çağıran muhafazakâr 1.0 varsayımına düşer',
    (value) => {
      expect(dailySurvivalRateFromCyclePercent(value)).toBeNull();
    },
  );
});

describe('FeedingForecastProjectionCompiler.compile (golden)', () => {
  const compiler = makeCompiler();
  const result = compiler.compile({
    units: [unitFixture()],
    feeds: feedFixtures(),
    horizonDays: 60,
    startDate: START,
  });
  const scope = result.find((r) => r.poolScope === 'TENANT');

  it('A→B band geçişini 12. günde işaretler; current ve terminal feed ayrıdır', () => {
    const unit = scope?.perUnit.find((u) => u.unitId === 'unit-1');
    expect(unit?.transitions).toEqual([
      { fromFeedId: FEED_A, toFeedId: FEED_B, estimatedDate: '2026-01-13', daysFromNow: 12 },
    ]);
    expect(unit?.currentFeedId).toBe(FEED_A);
    expect(unit?.terminalFeedId).toBe(FEED_B);
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
        { type: 'STOCKOUT_FORECAST', feedId: FEED_A, days: 5, atDay: 5 },
        { type: 'REORDER_NOW', feedId: FEED_A, days: 5, atDay: 0 },
        { type: 'STOCKOUT_FORECAST', feedId: FEED_B, days: 14, atDay: 14 },
        {
          type: 'TRANSITION_COVERAGE_GAP',
          feedId: FEED_B,
          unitId: 'unit-1',
          days: 1,
          atDay: 12,
        },
      ]),
    );
  });

  it('muhafazakâr varsayımı exact unit provenansıyla işaretler', () => {
    expect(scope?.mortalityAssumption).toEqual({
      schemaVersion: 'feeding-forecast-mortality-provenance/v1',
      coverage: 'NONE',
      unitCount: 1,
      speciesRateUnitCount: 0,
      conservativeDefaultUnitCount: 1,
      units: [{ unitId: 'unit-1', source: 'none', dailySurvivalRate: 1 }],
    });
  });
});

describe('FeedingForecastProjectionCompiler.compile (tenant havuzu + ölüm projeksiyonu)', () => {
  const compiler = makeCompiler();

  it('her ünite tenant otoritesine, yalnız depolu site ayrıca bilgi kapsamına girer', () => {
    const results = compiler.compile({
      units: [
        unitFixture(),
        unitFixture({
          unitId: 'unit-2',
          unitCode: 'T2',
          siteId: SITE_NO_STORAGE,
          hasLocalStorage: false,
        }),
      ],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    const scopeKeys = results.map((r) => r.siteScopeKey).sort();
    expect(scopeKeys).toEqual([SITE_1, TENANT_SCOPE_KEY].sort());
    const tenantScope = results.find((r) => r.siteScopeKey === TENANT_SCOPE_KEY);
    expect(tenantScope?.perFeed.find((f) => f.feedId === FEED_A)?.currentStockKg).toBe(100);
    expect(tenantScope?.perUnit.map((u) => u.unitId)).toEqual(['unit-1', 'unit-2']);
    expect(results.find((result) => result.siteScopeKey === SITE_1)?.poolScope).toBe('SITE');
    expect(results.some((result) => result.siteScopeKey === SITE_NO_STORAGE)).toBe(false);
  });

  it('tenant consumption equals each unit once while Site projection contains only local units', () => {
    const first = unitFixture({ unitId: 'unit-1' });
    const second = unitFixture({
      unitId: 'unit-2',
      siteId: SITE_NO_STORAGE,
      hasLocalStorage: false,
    });
    const combined = compiler.compile({
      units: [first, second],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    const tenant = combined.find((scope) => scope.poolScope === 'TENANT');
    const site = combined.find((scope) => scope.poolScope === 'SITE');
    const tenantTotal = tenant?.perFeed
      .flatMap((feed) => feed.dailyConsumptionSeries)
      .reduce((sum, kg) => sum + kg, 0);
    const siteTotal = site?.perFeed
      .flatMap((feed) => feed.dailyConsumptionSeries)
      .reduce((sum, kg) => sum + kg, 0);
    const oneUnitTotal = compiler
      .compile({
        units: [first],
        feeds: feedFixtures(),
        horizonDays: 30,
        startDate: START,
      })
      .find((scope) => scope.poolScope === 'TENANT')
      ?.perFeed.flatMap((feed) => feed.dailyConsumptionSeries)
      .reduce((sum, kg) => sum + kg, 0);
    expect(Math.abs((tenantTotal ?? 0) - (oneUnitTotal ?? 0) * 2)).toBeLessThan(0.05);
    expect(siteTotal).toBeCloseTo(oneUnitTotal ?? 0, 8);
  });

  it('site projection emits only transfer-needed when the tenant pool is sufficient', () => {
    const feeds = feedFixtures().map((feed) => ({
      ...feed,
      stockKgByScope: new Map([
        [SITE_1, 1],
        [TENANT_SCOPE_KEY, 10_000],
      ]),
    }));
    const results = compiler.compile({
      units: [unitFixture()],
      feeds,
      horizonDays: 30,
      startDate: START,
    });
    const tenant = results.find((scope) => scope.poolScope === 'TENANT');
    const site = results.find((scope) => scope.poolScope === 'SITE');
    expect(tenant?.alerts).toEqual([]);
    expect(site?.alerts).toEqual([
      { type: 'SITE_TRANSFER_NEEDED', feedId: FEED_A, days: 0, atDay: 0 },
    ]);
  });

  it('hayatta-kalma oranı uygulanınca tüketim düşer ve varsayım işaretlenir', () => {
    const [withMortality] = compiler.compile({
      units: [
        unitFixture({
          mortality: { source: 'species_survival_rate', dailySurvivalRate: 0.99 },
        }),
      ],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    const [without] = compiler.compile({
      units: [unitFixture()],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });
    expect(withMortality?.mortalityAssumption).toEqual({
      schemaVersion: 'feeding-forecast-mortality-provenance/v1',
      coverage: 'COMPLETE',
      unitCount: 1,
      speciesRateUnitCount: 1,
      conservativeDefaultUnitCount: 0,
      units: [
        { unitId: 'unit-1', source: 'species_survival_rate', dailySurvivalRate: 0.99 },
      ],
    });
    const consumedWith = withMortality?.perFeed
      .flatMap((f) => f.dailyConsumptionSeries)
      .reduce((a, b) => a + b, 0);
    const consumedWithout = without?.perFeed
      .flatMap((f) => f.dailyConsumptionSeries)
      .reduce((a, b) => a + b, 0);
    expect(consumedWith ?? 0).toBeLessThan(consumedWithout ?? Infinity);
  });

  it('does not collapse mixed mortality sources into a misleading global applied flag', () => {
    const [tenant] = compiler.compile({
      units: [
        unitFixture({
          unitId: 'unit-a',
          mortality: { source: 'species_survival_rate', dailySurvivalRate: 0.99 },
        }),
        unitFixture({
          unitId: 'unit-b',
          mortality: { source: 'none', dailySurvivalRate: 1 },
        }),
      ],
      feeds: feedFixtures(),
      horizonDays: 30,
      startDate: START,
    });

    expect(tenant?.mortalityAssumption).toMatchObject({
      coverage: 'PARTIAL',
      unitCount: 2,
      speciesRateUnitCount: 1,
      conservativeDefaultUnitCount: 1,
    });
    expect(tenant?.mortalityAssumption.units).toEqual([
      { unitId: 'unit-a', source: 'species_survival_rate', dailySurvivalRate: 0.99 },
      { unitId: 'unit-b', source: 'none', dailySurvivalRate: 1 },
    ]);
  });

  it('hasat kesintisi ünite tüketimini o günden itibaren azaltır (C-14 saf girdi)', () => {
    const [withHarvest] = compiler.compile({
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
