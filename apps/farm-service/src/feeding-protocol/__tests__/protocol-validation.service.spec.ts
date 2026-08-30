/**
 * ProtocolValidationService unit tests (feeding-protocol SSoT Faz 3).
 *
 * Tek doğrulama SSoT'si: band geometri kuralları (boşluk/örtüşme/min<max/cap),
 * oran-FCR-çarpan sınırları, öğün planı kuralları (saat formatı, kesin artan,
 * %toplam=100±0.01, giriş sayısı=mealsPerDay), sıcaklık bantları çakışmasız,
 * FCR matrisi boyut tutarlılığı + DoS cap'leri. v1 FeedingProgram
 * validateFeedAssignments/validateFCRTable semantiğinin portu + öğün kuralları.
 */
import { ProtocolValidationService } from '../services/protocol-validation.service';
import {
  MealSchedule,
  ProtocolBand,
  ProtocolFcrSource,
  ProtocolSettings,
  TemperatureAdjustment,
} from '../entities/feeding-protocol-v2.entity';

const FEED_A = '11111111-1111-4111-8111-111111111111';
const FEED_B = '22222222-2222-4222-8222-222222222222';

function band(over: Partial<ProtocolBand> = {}): ProtocolBand {
  return {
    minWeightG: 0,
    maxWeightG: 100,
    feedId: FEED_A,
    feedCode: 'FA',
    feedName: 'Feed A',
    feedingRatePercent: 3,
    expectedFcr: 1.1,
    ...over,
  };
}

function schedule(over: Partial<MealSchedule> = {}): MealSchedule {
  return {
    mealsPerDay: 2,
    entries: [
      { time: '08:00', percentOfDaily: 60 },
      { time: '16:00', percentOfDaily: 40 },
    ],
    ...over,
  };
}

function settings(over: Partial<ProtocolSettings> = {}): ProtocolSettings {
  return {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
    ...over,
  };
}

describe('ProtocolValidationService', () => {
  const service = new ProtocolValidationService();

  const validate = (
    bands: ProtocolBand[],
    opts: {
      defaultMealSchedule?: MealSchedule;
      temperatureAdjustments?: TemperatureAdjustment[];
      settings?: ProtocolSettings;
    } = {},
  ): string[] =>
    service.validateProtocol({
      bands,
      defaultMealSchedule: opts.defaultMealSchedule ?? schedule(),
      temperatureAdjustments: opts.temperatureAdjustments,
      settings: opts.settings ?? settings(),
    });

  describe('band geometry', () => {
    it('accepts contiguous half-open bands', () => {
      const errors = validate([
        band({ minWeightG: 0, maxWeightG: 100 }),
        band({
          minWeightG: 100,
          maxWeightG: 500,
          feedId: FEED_B,
          feedCode: 'FB',
          feedName: 'Feed B',
        }),
      ]);
      expect(errors).toEqual([]);
    });

    it('rejects an empty band list', () => {
      expect(validate([])).not.toEqual([]);
    });

    it('rejects gaps between bands', () => {
      const errors = validate([
        band({ minWeightG: 0, maxWeightG: 100 }),
        band({ minWeightG: 150, maxWeightG: 500 }),
      ]);
      expect(errors.join(' ')).toMatch(/gap|boşluk/i);
    });

    it('rejects overlapping bands', () => {
      const errors = validate([
        band({ minWeightG: 0, maxWeightG: 100 }),
        band({ minWeightG: 90, maxWeightG: 500 }),
      ]);
      expect(errors.join(' ')).toMatch(/overlap|örtüş/i);
    });

    it('rejects min >= max within a band', () => {
      expect(validate([band({ minWeightG: 100, maxWeightG: 100 })])).not.toEqual([]);
    });

    it('rejects more than MAX_PROTOCOL_BANDS bands', () => {
      const many = Array.from({ length: 51 }, (_, i) =>
        band({ minWeightG: i * 10, maxWeightG: (i + 1) * 10 }),
      );
      expect(validate(many).join(' ')).toMatch(/50/);
    });

    it('rejects out-of-bounds rate and FCR values', () => {
      expect(validate([band({ feedingRatePercent: 16 })])).not.toEqual([]);
      expect(validate([band({ feedingRatePercent: -1 })])).not.toEqual([]);
      expect(validate([band({ expectedFcr: 0.4 })])).not.toEqual([]);
      expect(validate([band({ expectedFcr: 5.1 })])).not.toEqual([]);
    });
  });

  describe('meal schedules', () => {
    it('rejects entries count differing from mealsPerDay', () => {
      const errors = validate([band()], {
        defaultMealSchedule: schedule({ mealsPerDay: 3 }),
      });
      expect(errors).not.toEqual([]);
    });

    it('rejects percentages not summing to 100', () => {
      const errors = validate([band()], {
        defaultMealSchedule: schedule({
          entries: [
            { time: '08:00', percentOfDaily: 50 },
            { time: '16:00', percentOfDaily: 40 },
          ],
        }),
      });
      expect(errors.join(' ')).toMatch(/100/);
    });

    it('accepts percentages within the ±0.01 tolerance', () => {
      const errors = validate([band()], {
        defaultMealSchedule: schedule({
          mealsPerDay: 3,
          entries: [
            { time: '08:00', percentOfDaily: 33.33 },
            { time: '12:00', percentOfDaily: 33.33 },
            { time: '16:00', percentOfDaily: 33.335 },
          ],
        }),
      });
      expect(errors).toEqual([]);
    });

    it('rejects malformed or non-increasing times', () => {
      expect(
        validate([band()], {
          defaultMealSchedule: schedule({
            entries: [
              { time: '8am', percentOfDaily: 60 },
              { time: '16:00', percentOfDaily: 40 },
            ],
          }),
        }),
      ).not.toEqual([]);
      expect(
        validate([band()], {
          defaultMealSchedule: schedule({
            entries: [
              { time: '16:00', percentOfDaily: 60 },
              { time: '08:00', percentOfDaily: 40 },
            ],
          }),
        }),
      ).not.toEqual([]);
    });

    it('rejects mealsPerDay outside 1..24', () => {
      expect(
        validate([band()], {
          defaultMealSchedule: { mealsPerDay: 0, entries: [] },
        }),
      ).not.toEqual([]);
    });

    it('validates band-level schedule overrides too', () => {
      const errors = validate([
        band({
          mealSchedule: {
            mealsPerDay: 2,
            entries: [
              { time: '08:00', percentOfDaily: 90 },
              { time: '16:00', percentOfDaily: 20 },
            ],
          },
        }),
      ]);
      expect(errors.join(' ')).toMatch(/100/);
    });
  });

  describe('temperature adjustments', () => {
    it('rejects overlapping temperature bands', () => {
      const errors = validate([band()], {
        temperatureAdjustments: [
          { minC: 5, maxC: 12, rateMultiplier: 0.8 },
          { minC: 10, maxC: 18, rateMultiplier: 1.0 },
        ],
      });
      expect(errors.join(' ')).toMatch(/overlap|örtüş/i);
    });

    it('rejects multipliers outside 0.1..2', () => {
      const errors = validate([band()], {
        temperatureAdjustments: [{ minC: 5, maxC: 12, rateMultiplier: 2.5 }],
      });
      expect(errors).not.toEqual([]);
    });
  });

  describe('fcr matrix', () => {
    it('rejects dimension mismatches and cap violations', () => {
      const errors = service.validateProtocol({
        bands: [band()],
        defaultMealSchedule: schedule(),
        settings: settings({ fcrSource: ProtocolFcrSource.MATRIX }),
        fcrMatrix: { temperatures: [10, 14], weights: [50], fcrValues: [[1.1]] },
      });
      expect(errors).not.toEqual([]);
    });

    it('requires a matrix when fcrSource is MATRIX', () => {
      const errors = service.validateProtocol({
        bands: [band()],
        defaultMealSchedule: schedule(),
        settings: settings({ fcrSource: ProtocolFcrSource.MATRIX }),
      });
      expect(errors.join(' ')).toMatch(/matrix|matris/i);
    });
  });
});
