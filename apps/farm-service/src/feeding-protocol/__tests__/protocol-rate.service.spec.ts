/**
 * ProtocolRateService unit tests (feeding-protocol SSoT Faz 3).
 *
 * Pinler: yarı-açık [min,max) band çözümü + kenar clamp'i; sıcaklık çarpanı
 * (okuma yok → 1.0 — P-20 kuralı: default sıcaklık asla oran ölçeklemez);
 * etkin oran formülü base × tempMult × (1 + rateAdj/100) [K-18 düzeltmesi] +
 * settings min/max clamp'i; beklenen-FCR çözüm sırası OVERRIDE → BAND|MATRIX|FEED
 * (§3) ve provenans etiketi (fcrResolvedSource — K-15).
 */
import { ProtocolRateService } from '../services/protocol-rate.service';
import {
  FcrResolvedSource,
  ProtocolBand,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';

const FEED_A = '11111111-1111-4111-8111-111111111111';
const FEED_B = '22222222-2222-4222-8222-222222222222';

const bands: ProtocolBand[] = [
  {
    minWeightG: 0,
    maxWeightG: 100,
    feedId: FEED_A,
    feedCode: 'FA',
    feedName: 'Feed A',
    feedingRatePercent: 4,
    expectedFcr: 1.0,
  },
  {
    minWeightG: 100,
    maxWeightG: 500,
    feedId: FEED_B,
    feedCode: 'FB',
    feedName: 'Feed B',
    feedingRatePercent: 2,
    expectedFcr: 1.3,
  },
];

describe('ProtocolRateService', () => {
  const service = new ProtocolRateService();

  describe('bandFor — half-open bands with edge clamping', () => {
    it('resolves the band whose [min,max) range contains the weight', () => {
      expect(service.bandFor(bands, 50)?.index).toBe(0);
      expect(service.bandFor(bands, 250)?.index).toBe(1);
    });

    it('treats the upper bound as exclusive (100g belongs to the next band)', () => {
      expect(service.bandFor(bands, 100)?.index).toBe(1);
    });

    it('clamps below the first band and at/above the last band edge', () => {
      expect(service.bandFor(bands, -5)?.index).toBe(0);
      expect(service.bandFor(bands, 9999)?.index).toBe(1);
    });

    it('returns null for an empty band list', () => {
      expect(service.bandFor([], 50)).toBeNull();
    });
  });

  describe('temperatureMultiplier', () => {
    const adjustments = [
      { minC: 0, maxC: 10, rateMultiplier: 0.7 },
      { minC: 10, maxC: 18, rateMultiplier: 1.0 },
    ];

    it('applies the matching temperature band multiplier', () => {
      expect(service.temperatureMultiplier(adjustments, 5)).toBe(0.7);
      expect(service.temperatureMultiplier(adjustments, 12)).toBe(1.0);
    });

    it('returns 1.0 when there is NO temperature reading (P-20: default never scales)', () => {
      expect(service.temperatureMultiplier(adjustments, null)).toBe(1.0);
    });

    it('returns 1.0 when no band matches or no adjustments are defined', () => {
      expect(service.temperatureMultiplier(adjustments, 30)).toBe(1.0);
      expect(service.temperatureMultiplier(undefined, 12)).toBe(1.0);
    });
  });

  describe('effectiveRatePercent', () => {
    it('multiplies base rate, temperature multiplier and rate adjustment', () => {
      // 4% × 0.7 × (1 + 10/100) = 3.08 — K-18: adj yüzdedir, (1+adj)/100 değil.
      const rate = service.effectiveRatePercent({
        baseRatePercent: 4,
        temperatureMultiplier: 0.7,
        rateAdjustmentPercent: 10,
      });
      expect(rate).toBeCloseTo(3.08, 5);
    });

    it('clamps to protocol min/max rate bounds when configured', () => {
      const rate = service.effectiveRatePercent({
        baseRatePercent: 4,
        temperatureMultiplier: 2,
        minRatePercent: 1,
        maxRatePercent: 6,
      });
      expect(rate).toBe(6);
    });
  });

  describe('resolveExpectedFcr — OVERRIDE → BAND|MATRIX|FEED', () => {
    const band = bands[1]!;

    it('unit-level override wins over every source', () => {
      const result = service.resolveExpectedFcr({
        band,
        fcrSource: ProtocolFcrSource.MATRIX,
        protocolFcrMatrix: { temperatures: [10], weights: [200], fcrValues: [[2.2]] },
        fcrOverrides: [{ feedId: FEED_B, expectedFcr: 1.05 }],
        avgWeightG: 200,
        temperatureC: 10,
      });
      expect(result).toEqual({ value: 1.05, source: FcrResolvedSource.OVERRIDE });
    });

    it('band scalar is the default source', () => {
      const result = service.resolveExpectedFcr({
        band,
        fcrSource: ProtocolFcrSource.BAND,
        avgWeightG: 200,
        temperatureC: 10,
      });
      expect(result).toEqual({ value: 1.3, source: FcrResolvedSource.BAND });
    });

    it('matrix source interpolates the protocol FCR matrix', () => {
      const result = service.resolveExpectedFcr({
        band,
        fcrSource: ProtocolFcrSource.MATRIX,
        protocolFcrMatrix: {
          temperatures: [10, 20],
          weights: [100, 300],
          fcrValues: [
            [1.0, 1.2],
            [1.4, 1.6],
          ],
        },
        avgWeightG: 200,
        temperatureC: 15,
      });
      expect(result.source).toBe(FcrResolvedSource.MATRIX);
      expect(result.value).toBeCloseTo(1.3, 5);
    });

    it('falls back to the band scalar when the configured matrix is absent', () => {
      const result = service.resolveExpectedFcr({
        band,
        fcrSource: ProtocolFcrSource.MATRIX,
        avgWeightG: 200,
        temperatureC: 15,
      });
      expect(result).toEqual({ value: 1.3, source: FcrResolvedSource.BAND });
    });

    it('feed source uses the feed matrix and labels provenance FEED', () => {
      const result = service.resolveExpectedFcr({
        band,
        fcrSource: ProtocolFcrSource.FEED,
        feedFcrMatrix: {
          temperatures: [15],
          weights: [200],
          fcrValues: [[1.45]],
        },
        avgWeightG: 200,
        temperatureC: 15,
      });
      expect(result.source).toBe(FcrResolvedSource.FEED);
      expect(result.value).toBeCloseTo(1.45, 5);
    });

    it('clamps every resolved value into the 0.5–5 biological range', () => {
      const result = service.resolveExpectedFcr({
        band,
        fcrSource: ProtocolFcrSource.BAND,
        fcrOverrides: [{ feedId: FEED_B, expectedFcr: 9 }],
        avgWeightG: 200,
        temperatureC: 10,
      });
      expect(result.value).toBe(5);
    });
  });
});
