/**
 * Öğün türetme + saat maddileştirme kuralları (Faz 5 — K-18/D-15 + D-4).
 *
 * Pinler: band planı protokol default'unu ezer; mealsPerDayOverride saatleri
 * taban planın ilk-son penceresine eşit dağıtır; offset EN SON uygulanır ve
 * gün sınırından taşabilir; DST geçiş gecelerinde öğün ne atlanır ne çiftlenir;
 * gün içi reprice her kalan öğüne KENDİ yüzdesinin yeni günlük karşılığını verir.
 */
import {
  effectiveMealSchedule,
  materializeMeals,
  repriceRemaining,
  suspensionFor,
} from '../services/meal-schedule.util';
import { compileFeedingTimezone, feedingWallTimeToInstant } from '@aquaculture/feeding-contracts';
import type { MealSchedule, ProtocolBand } from '../entities/feeding-protocol-v2.entity';

const DEFAULT_SCHEDULE: MealSchedule = {
  mealsPerDay: 3,
  entries: [
    { time: '08:00', percentOfDaily: 40 },
    { time: '13:00', percentOfDaily: 30 },
    { time: '18:00', percentOfDaily: 30 },
  ],
};

const band = (schedule?: MealSchedule): ProtocolBand => ({
  minWeightG: 0,
  maxWeightG: 100,
  feedId: 'feed-1',
  feedCode: 'FA',
  feedName: 'Feed A',
  feedingRatePercent: 3,
  expectedFcr: 1.2,
  mealSchedule: schedule,
});

describe('effectiveMealSchedule', () => {
  it('prefers the band schedule over the protocol default', () => {
    const bandSchedule: MealSchedule = {
      mealsPerDay: 2,
      entries: [
        { time: '09:00', percentOfDaily: 50 },
        { time: '15:00', percentOfDaily: 50 },
      ],
    };
    const result = effectiveMealSchedule(DEFAULT_SCHEDULE, band(bandSchedule), undefined);
    expect(result).toBe(bandSchedule);
  });

  it('derives times evenly across the base first-last window on mealsPerDayOverride (D-15)', () => {
    const result = effectiveMealSchedule(DEFAULT_SCHEDULE, band(), {
      mealsPerDayOverride: 5,
    });
    expect(result.mealsPerDay).toBe(5);
    expect(result.entries.map((entry) => entry.time)).toEqual([
      '08:00',
      '10:30',
      '13:00',
      '15:30',
      '18:00',
    ]);
    const sum = result.entries.reduce((acc, entry) => acc + entry.percentOfDaily, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01);
  });
});

describe('feedingWallTimeToInstant (D-4)', () => {
  it('materializes Istanbul wall time as the correct UTC instant', () => {
    // Europe/Istanbul sabit UTC+3 — 08:00 duvar saati = 05:00Z.
    const instant = feedingWallTimeToInstant(
      '2026-07-20',
      '08:00',
      compileFeedingTimezone('Europe/Istanbul'),
    );
    expect(instant.toISOString()).toBe('2026-07-20T05:00:00.000Z');
  });

  it('does not skip meals across the DST spring-forward gap (shifts forward)', () => {
    // Europe/Oslo 2026-03-29: 02:00→03:00 ileri atlar; 02:30 duvar saati YOK.
    // Canonical next_valid_instant politikası geçişten sonraki ilk gerçek anı
    // seçer: 03:00 CEST. Aynı policy scheduler catalog ve job compiler'da da
    // kullanılır; uygulama katmanı ikinci bir DST kuralı tanımlamaz.
    const instant = feedingWallTimeToInstant(
      '2026-03-29',
      '02:30',
      compileFeedingTimezone('Europe/Oslo'),
    );
    expect(instant.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('picks the FIRST occurrence on the DST fall-back night (no double meal)', () => {
    // Europe/Oslo 2026-10-25: 03:00→02:00 geri alınır; 02:30 iki kez yaşanır.
    const instant = feedingWallTimeToInstant(
      '2026-10-25',
      '02:30',
      compileFeedingTimezone('Europe/Oslo'),
    );
    expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z'); // CEST (+2) oluşu
  });
});

describe('materializeMeals', () => {
  it('applies mealTimeOffsetMinutes LAST and can spill across midnight', () => {
    const meals = materializeMeals(
      {
        mealsPerDay: 2,
        entries: [
          { time: '08:00', percentOfDaily: 50 },
          { time: '23:30', percentOfDaily: 50 },
        ],
      },
      '2026-07-20',
      compileFeedingTimezone('Europe/Istanbul'),
      60,
    );
    expect(meals[0]!.scheduledAt.toISOString()).toBe('2026-07-20T06:00:00.000Z'); // 09:00 TRT
    // 23:30 + 60dk = ertesi gün 00:30 TRT = 21:30Z aynı UTC günü
    expect(meals[1]!.scheduledAt.toISOString()).toBe('2026-07-20T21:30:00.000Z');
  });
});

describe('suspensionFor (D-12)', () => {
  const suspensions = [
    { from: '2026-07-20', to: '2026-07-22', type: 'fasting' as const, reason: 'vet' },
  ];

  it('matches inclusive date bounds and misses outside days', () => {
    expect(suspensionFor(suspensions, '2026-07-20')?.type).toBe('fasting');
    expect(suspensionFor(suspensions, '2026-07-22')?.type).toBe('fasting');
    expect(suspensionFor(suspensions, '2026-07-23')).toBeUndefined();
  });
});

describe('repriceRemaining (P-31)', () => {
  it('gives each remaining meal ITS OWN percent of the NEW daily total', () => {
    const remaining = [{ percentOfDaily: 30 }, { percentOfDaily: 30 }];
    expect(repriceRemaining(remaining, 90)).toEqual([27, 27]);
  });
});
