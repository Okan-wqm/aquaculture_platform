/**
 * SGR Calculator Service Unit Tests
 *
 * Specific Growth Rate (SGR) hesaplama servisinin kapsamlı testleri.
 *
 * Phase 5.6 rewrite — the original spec predated a full API
 * redesign that:
 *   - Changed `calculateSGR(initial, final, days)` return type
 *     from `number` to `SGRResult` (carries validity + warning).
 *   - Renamed `SGRTrend` to `SGRTrendAnalysis` and reshaped it.
 *   - Removed `rateSGR`, `getBatchSGR`, `getSGRTrend`,
 *     `compareToTarget`, `calculateDailyGrowthRate` — their
 *     responsibilities were consolidated into `calculateSGR` +
 *     `analyzeSGRTrend` + `compareBatchSGR`.
 *
 * This spec covers the current public API only. Tests against
 * deleted methods were removed rather than ported; keeping tests
 * for fictional methods is worse than no coverage for them.
 *
 * @module Batch/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SGRCalculatorService, SGRResult } from '../../services/sgr-calculator.service';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';
import { Batch } from '../../entities/batch.entity';
import { Species } from '../../../species/entities/species.entity';

describe('SGRCalculatorService', () => {
  let service: SGRCalculatorService;

  const mockMeasurementRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };
  const mockBatchRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };
  const mockSpeciesRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SGRCalculatorService,
        {
          provide: getRepositoryToken(GrowthMeasurement),
          useValue: mockMeasurementRepo,
        },
        { provide: getRepositoryToken(Batch), useValue: mockBatchRepo },
        { provide: getRepositoryToken(Species), useValue: mockSpeciesRepo },
      ],
    }).compile();

    service = module.get<SGRCalculatorService>(SGRCalculatorService);
    jest.clearAllMocks();
  });

  describe('calculateSGR', () => {
    it('calculates SGR correctly for normal growth', () => {
      // SGR = (ln(finalWeight) - ln(initialWeight)) / days * 100
      // Expected: (ln(150) - ln(100)) / 14 * 100 ≈ 2.89%
      const result: SGRResult = service.calculateSGR(100, 150, 14);
      expect(result.isValid).toBe(true);
      expect(result.sgr).toBeCloseTo(2.89, 1);
      expect(result.initialWeightG).toBe(100);
      expect(result.finalWeightG).toBe(150);
      expect(result.days).toBe(14);
      expect(result.warning).toBeUndefined();
    });

    it('flags zero or negative days as invalid', () => {
      const zeroDays = service.calculateSGR(100, 150, 0);
      expect(zeroDays.isValid).toBe(false);
      expect(zeroDays.sgr).toBe(0);
      expect(zeroDays.warning).toBeDefined();

      const negDays = service.calculateSGR(100, 150, -5);
      expect(negDays.isValid).toBe(false);
      expect(negDays.sgr).toBe(0);
    });

    it('flags zero or negative initial weight as invalid', () => {
      expect(service.calculateSGR(0, 100, 14).isValid).toBe(false);
      expect(service.calculateSGR(-10, 100, 14).isValid).toBe(false);
    });

    it('flags zero or negative final weight as invalid', () => {
      expect(service.calculateSGR(100, 0, 14).isValid).toBe(false);
      expect(service.calculateSGR(100, -10, 14).isValid).toBe(false);
    });

    it('handles weight loss — computes negative SGR and flags it invalid with a warning', () => {
      // The service's `isValid` is `sgr >= 0 && sgr <= 10` — a
      // negative SGR is a sentinel that flags suspect data or a
      // batch in distress. The math is still correct; the
      // warning + invalid flag surface the condition to the
      // caller.
      const result = service.calculateSGR(150, 100, 14);
      expect(result.sgr).toBeLessThan(0);
      expect(result.sgr).toBeCloseTo(-2.89, 1);
      expect(result.isValid).toBe(false);
      expect(result.warning).toMatch(/Negatif SGR/);
    });

    it('flags anomalously high SGR (>10%/day) as invalid with a warning', () => {
      // Tight initial→final jump over a short window — drives the
      // SGR past the 10 %/day sanity ceiling and triggers the
      // high-SGR warning.
      const result = service.calculateSGR(1, 100, 3); // ~153 %/day
      expect(result.sgr).toBeGreaterThan(10);
      expect(result.isValid).toBe(false);
      expect(result.warning).toMatch(/Anormal yüksek SGR/);
    });

    it('calculates correctly for small weight change', () => {
      const result = service.calculateSGR(100, 101, 7);
      expect(result.isValid).toBe(true);
      expect(result.sgr).toBeGreaterThan(0);
      expect(result.sgr).toBeLessThan(1);
    });

    it('calculates correctly for rapid growth (4× over 30 days)', () => {
      // Expected: (ln(200) - ln(50)) / 30 * 100 ≈ 4.62%
      const result = service.calculateSGR(50, 200, 30);
      expect(result.isValid).toBe(true);
      expect(result.sgr).toBeCloseTo(4.62, 1);
    });
  });
});
