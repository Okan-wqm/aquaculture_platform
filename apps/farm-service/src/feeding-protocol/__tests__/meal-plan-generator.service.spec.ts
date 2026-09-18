/**
 * computeDayPlan saf çekirdeği (Faz 5 — plan §2 + NFR).
 *
 * Pinler: K-18 oran zinciri (band × sıcaklık × rateAdj, min/max clamp);
 * sıcaklık yokken çarpan 1.0 + açık bayrak (P-20); temizlikçi balık yem
 * tabanına girmez (D-13 — biomass tabanı üretim biomass'ı); oruç penceresi
 * günü atlar, ilaç penceresi öğün yemini değiştirir (D-12); boş ünite plan
 * üretmez; FCR override provenansı OVERRIDE olarak raporlanır.
 */
import {
  MealPlanGeneratorService,
  mixedTankStats,
  type ComputeDayPlanInput,
} from '../services/meal-plan-generator.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import { ProtocolResolutionService } from '../services/protocol-resolution.service';
import { FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import {
  FcrResolvedSource,
  ProtocolFcrSource,
  type MealSchedule,
} from '../entities/feeding-protocol-v2.entity';
import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';

const SCHEDULE: MealSchedule = {
  mealsPerDay: 2,
  entries: [
    { time: '08:00', percentOfDaily: 60 },
    { time: '16:00', percentOfDaily: 40 },
  ],
};

const PROTOCOL = {
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 100,
      feedId: 'feed-a',
      feedCode: 'FA',
      feedName: 'Feed A',
      feedingRatePercent: 3,
      expectedFcr: 1.2,
    },
    {
      minWeightG: 100,
      maxWeightG: 500,
      feedId: 'feed-b',
      feedCode: 'FB',
      feedName: 'Feed B',
      feedingRatePercent: 2,
      expectedFcr: 1.4,
    },
  ],
  defaultMealSchedule: SCHEDULE,
  temperatureAdjustments: [{ minC: 5, maxC: 12, rateMultiplier: 0.5 }],
  fcrMatrix: undefined,
  settings: {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal' as const,
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
};

const TEMP_NONE: EffectiveTemperature = { celsius: null, source: 'none' };
const TEMP_COLD: EffectiveTemperature = { celsius: 8, source: 'sensor', sensorId: 's1' };

const generatorRateService = new ProtocolRateService();
const service = new MealPlanGeneratorService(
  generatorRateService,
  new ProtocolResolutionService(generatorRateService),
);

const baseInput = (): ComputeDayPlanInput => ({
  assignment: { overrides: {}, suspensions: [], currentFeedId: undefined },
  protocol: PROTOCOL,
  stock: { fishCount: 1000, biomassKg: 50, avgWeightG: 50 },
  temperature: TEMP_NONE,
  planDate: '2026-07-20',
  timezone: 'Europe/Istanbul',
});

describe('mixedTankStats (D-2 — FARM-MEDIUM-231, saf)', () => {
  it('tek (veya boş) üretim batch → mixed değil, CV null', () => {
    expect(mixedTankStats([{ quantity: 1000, avgWeightG: 50 }])).toEqual({
      mixedBatch: false,
      weightCvPercent: null,
    });
    expect(mixedTankStats([])).toEqual({ mixedBatch: false, weightCvPercent: null });
    expect(mixedTankStats(undefined)).toEqual({ mixedBatch: false, weightCvPercent: null });
  });

  it('sıfır adetli batch detayı sayılmaz (tam çıkmış batch mixed yapmaz)', () => {
    expect(
      mixedTankStats([
        { quantity: 1000, avgWeightG: 50 },
        { quantity: 0, avgWeightG: 500 },
      ]),
    ).toEqual({ mixedBatch: false, weightCvPercent: null });
  });

  it('iki eşit batch, %50/%150 ağırlık → mixed + adet-ağırlıklı CV %50', () => {
    const stats = mixedTankStats([
      { quantity: 500, avgWeightG: 50 },
      { quantity: 500, avgWeightG: 150 },
    ]);
    expect(stats.mixedBatch).toBe(true);
    // mean=100, σ=50 → CV %50.
    expect(stats.weightCvPercent).toBeCloseTo(50);
  });

  it('aynı ağırlıklı iki batch → mixed ama CV %0 (uyarı eşiği altında)', () => {
    const stats = mixedTankStats([
      { quantity: 300, avgWeightG: 80 },
      { quantity: 700, avgWeightG: 80 },
    ]);
    expect(stats.mixedBatch).toBe(true);
    expect(stats.weightCvPercent).toBe(0);
  });
});

describe('MealPlanGeneratorService.computeDayPlan', () => {
  it('snapshot karışık-tank istatistiğini taşır; verilmezse false/null (D-2)', () => {
    const mixed = service.computeDayPlan({
      ...baseInput(),
      stock: {
        fishCount: 1000,
        biomassKg: 50,
        avgWeightG: 50,
        mixedBatch: true,
        weightCvPercent: 32.5,
      },
    });
    expect(mixed!.snapshot.mixedBatch).toBe(true);
    expect(mixed!.snapshot.weightCvPercent).toBe(32.5);

    const single = service.computeDayPlan(baseInput());
    expect(single!.snapshot.mixedBatch).toBe(false);
    expect(single!.snapshot.weightCvPercent).toBeNull();
  });

  it('computes daily total from production biomass with multiplier 1.0 when no temperature', () => {
    const plan = service.computeDayPlan(baseInput());
    expect(plan).not.toBeNull();
    // 50kg × 3% = 1.5kg; sıcaklık yok → çarpan 1.0 + açık bayrak
    expect(plan!.plannedTotalKg).toBeCloseTo(1.5);
    expect(plan!.snapshot.tempMultiplier).toBe(1.0);
    expect(plan!.snapshot.usingDefaultTemperature).toBe(true);
    expect(plan!.snapshot.temperatureSource).toBe('none');
    expect(plan!.meals.map((meal) => meal.plannedKg)).toEqual([0.9, 0.6]);
    expect(plan!.snapshot.fcrResolvedSource).toBe(FcrResolvedSource.BAND);
  });

  it('applies the K-18 chain: band rate x temp multiplier x (1 + rateAdj/100)', () => {
    const input = baseInput();
    input.temperature = TEMP_COLD; // 8°C → ×0.5
    input.assignment.overrides = { rateAdjustmentPercent: 20 }; // ×1.2
    const plan = service.computeDayPlan(input);
    // 3% × 0.5 × 1.2 = 1.8% → 50kg × 1.8% = 0.9kg
    expect(plan!.snapshot.effectiveRatePercent).toBeCloseTo(1.8);
    expect(plan!.plannedTotalKg).toBeCloseTo(0.9);
    expect(plan!.snapshot.tempMultiplier).toBe(0.5);
  });

  it('excludes cleaner fish structurally: the biomass basis IS the production biomass (D-13)', () => {
    // Çağıran totalBiomassKg (üretim) verir; temizlikçi biomass'ı ayrı alanda
    // yaşar ve bu API'ye HİÇ girmez — 50kg üretim + 10kg temizlikçi = 50kg taban.
    const plan = service.computeDayPlan(baseInput());
    expect(plan!.snapshot.biomassKg).toBe(50);
    expect(plan!.plannedTotalKg).toBeCloseTo(1.5);
  });

  it('produces no plan for an empty unit', () => {
    const input = baseInput();
    input.stock = { fishCount: 0, biomassKg: 0, avgWeightG: 0 };
    expect(service.computeDayPlan(input)).toBeNull();
  });

  it('skips the day inside a fasting window and keeps automatic resume (D-12)', () => {
    const input = baseInput();
    input.assignment.suspensions = [
      { from: '2026-07-19', to: '2026-07-21', type: 'fasting', reason: 'vet directive' },
    ];
    const plan = service.computeDayPlan(input);
    expect(plan!.status).toBe(FeedingDayPlanStatus.SKIPPED);
    expect(plan!.skipReason).toContain('fasting');
    expect(plan!.meals).toHaveLength(0);
    expect(plan!.plannedTotalKg).toBe(0);
  });

  it('swaps meal feed to medicatedFeedId inside a medication window (D-12)', () => {
    const input = baseInput();
    input.assignment.suspensions = [
      {
        from: '2026-07-20',
        to: '2026-07-25',
        type: 'medication',
        reason: 'antibiotic course',
        medicatedFeedId: 'feed-med',
      },
    ];
    const plan = service.computeDayPlan(input);
    expect(plan!.status).toBe(FeedingDayPlanStatus.PLANNED);
    expect(plan!.meals.every((meal) => meal.feedId === 'feed-med')).toBe(true);
    // Snapshot band yemi korunur — geçiş değerlendirmesi band üzerinden sürer.
    expect(plan!.snapshot.feed.id).toBe('feed-a');
  });

  it('reports OVERRIDE provenance when the unit overrides the band FCR (R11)', () => {
    const input = baseInput();
    input.assignment.overrides = { fcrOverrides: [{ feedId: 'feed-a', expectedFcr: 0.9 }] };
    const plan = service.computeDayPlan(input);
    expect(plan!.snapshot.expectedFcr).toBe(0.9);
    expect(plan!.snapshot.fcrResolvedSource).toBe(FcrResolvedSource.OVERRIDE);
  });

  it('materializes meal times in the site timezone (D-4)', () => {
    const plan = service.computeDayPlan(baseInput());
    expect(plan!.meals[0]!.scheduledAt.toISOString()).toBe('2026-07-20T05:00:00.000Z'); // 08:00 TRT
    expect(plan!.meals[1]!.scheduledAt.toISOString()).toBe('2026-07-20T13:00:00.000Z'); // 16:00 TRT
  });
});
