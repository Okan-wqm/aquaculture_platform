/**
 * BatchDomainService Unit Tests
 *
 * IP-3: Tests for domain logic extracted from batch.entity.ts.
 * Pure calculations — no database, no DI, no side effects.
 */
import { BadRequestException } from '@nestjs/common';

import { BatchDomainService } from '../../services/batch-domain.service';
import { Batch, BatchStatus, BatchType } from '../../entities/batch.entity';

describe('BatchDomainService', () => {
  let service: BatchDomainService;

  beforeEach(() => {
    service = new BatchDomainService();
  });

  // ── Helper: create a partial Batch with sensible defaults ─────────────

  function createBatch(overrides: Partial<Batch> = {}): Batch {
    return {
      id: 'batch-1',
      tenantId: 'tenant-1',
      batchNumber: 'B-001',
      initialQuantity: 10000,
      currentQuantity: 9500,
      totalMortality: 300,
      cullCount: 200,
      totalFeedConsumed: 5000,
      stockedAt: new Date('2025-01-01'),
      actualHarvestDate: undefined,
      status: BatchStatus.GROWING,
      batchType: BatchType.PRODUCTION,
      weight: {
        initial: { avgWeight: 50, totalBiomass: 500, measuredAt: new Date() },
        theoretical: {
          avgWeight: 150,
          totalBiomass: 1425,
          lastCalculatedAt: new Date(),
          basedOnFCR: 1.2,
        },
        actual: {
          avgWeight: 160,
          totalBiomass: 1520,
          lastMeasuredAt: new Date(),
          sampleSize: 100,
          confidencePercent: 95,
        },
        variance: { weightDifference: 10, percentageDifference: 6.67, isSignificant: false },
      },
      ...overrides,
    } as Batch;
  }

  // ── Biomass & Weight ──────────────────────────────────────────────────

  describe('getCurrentBiomass (derive-on-read)', () => {
    // Biomass is DERIVED: currentQuantity × effectiveAvgWeightG / 1000.
    // It no longer reads the stored weight.actual.totalBiomass snapshot.

    it('should derive from currentQuantity × actual avgWeight', () => {
      const batch = createBatch(); // 9500 × 160 / 1000 = 1520
      expect(service.getCurrentBiomass(batch)).toBe(1520);
    });

    it('should track currentQuantity decrements (cannot go stale)', () => {
      // The stored snapshot still says totalBiomass=1520, but after 500 fish
      // are removed the derived biomass drops — proving it tracks the live count.
      const batch = createBatch({ currentQuantity: 9000 }); // 9000 × 160 / 1000
      expect(service.getCurrentBiomass(batch)).toBe(1440);
    });

    it('should fall back to theoretical avgWeight when actual avgWeight is 0', () => {
      const batch = createBatch({
        currentQuantity: 9500,
        weight: {
          initial: { avgWeight: 50, totalBiomass: 500, measuredAt: new Date() },
          theoretical: {
            avgWeight: 150,
            totalBiomass: 1425,
            lastCalculatedAt: new Date(),
            basedOnFCR: 1.2,
          },
          actual: {
            avgWeight: 0,
            totalBiomass: 0,
            lastMeasuredAt: new Date(),
            sampleSize: 0,
            confidencePercent: 0,
          },
          variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
        },
      });
      expect(service.getCurrentBiomass(batch)).toBe(1425); // 9500 × 150 / 1000
    });

    it('should fall back to initial avgWeight when actual+theoretical are 0', () => {
      const batch = createBatch({
        currentQuantity: 9500,
        weight: {
          initial: { avgWeight: 50, totalBiomass: 500, measuredAt: new Date() },
          theoretical: {
            avgWeight: 0,
            totalBiomass: 0,
            lastCalculatedAt: new Date(),
            basedOnFCR: 0,
          },
          actual: {
            avgWeight: 0,
            totalBiomass: 0,
            lastMeasuredAt: new Date(),
            sampleSize: 0,
            confidencePercent: 0,
          },
          variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
        },
      });
      expect(service.getCurrentBiomass(batch)).toBe(475); // 9500 × 50 / 1000
    });

    it('should return 0 when no weight data exists', () => {
      const batch = createBatch({ weight: undefined });
      expect(service.getCurrentBiomass(batch)).toBe(0);
    });

    it('should return 0 when the batch is empty', () => {
      const batch = createBatch({ currentQuantity: 0 });
      expect(service.getCurrentBiomass(batch)).toBe(0);
    });
  });

  describe('getCurrentAvgWeight', () => {
    it('should return actual avg weight when available', () => {
      const batch = createBatch();
      expect(service.getCurrentAvgWeight(batch)).toBe(160);
    });
  });

  // ── Mortality & Survival ──────────────────────────────────────────────

  describe('getMortalityRate', () => {
    it('should calculate mortality rate correctly', () => {
      const batch = createBatch({ initialQuantity: 10000, totalMortality: 300 });
      expect(service.getMortalityRate(batch)).toBe(3);
    });

    it('should return 0 for zero initial quantity', () => {
      const batch = createBatch({ initialQuantity: 0 });
      expect(service.getMortalityRate(batch)).toBe(0);
    });
  });

  describe('getSurvivalRate', () => {
    it('should calculate survival rate = 100 - mortality rate', () => {
      const batch = createBatch({ initialQuantity: 10000, totalMortality: 300 });
      expect(service.getSurvivalRate(batch)).toBe(97);
    });

    it('should return 100 for zero initial quantity', () => {
      const batch = createBatch({ initialQuantity: 0 });
      expect(service.getSurvivalRate(batch)).toBe(100);
    });
  });

  describe('getRetentionRate', () => {
    it('should include culls and mortality in retention calculation', () => {
      const batch = createBatch({ initialQuantity: 10000, currentQuantity: 9500 });
      expect(service.getRetentionRate(batch)).toBe(95);
    });
  });

  // ── Performance Metrics ───────────────────────────────────────────────

  // NOTE: calculateFCR was removed from BatchDomainService (one-SSoT
  // consolidation). The single FCR authority is now
  // FcrCalculationService.calculateCumulativeFCR, which is covered by its own
  // ledger-aware spec.

  describe('assertFeedable', () => {
    it.each([
      BatchStatus.ACTIVE,
      BatchStatus.GROWING,
      BatchStatus.PRE_HARVEST,
      BatchStatus.HARVESTING,
    ])('should not throw for feedable status %s with live fish', (status) => {
      const batch = createBatch({ status, currentQuantity: 9500 });
      expect(() => service.assertFeedable(batch)).not.toThrow();
    });

    it.each([
      BatchStatus.QUARANTINE,
      BatchStatus.HARVESTED,
      BatchStatus.TRANSFERRED,
      BatchStatus.FAILED,
      BatchStatus.CLOSED,
    ])('should throw BadRequestException for non-feedable status %s', (status) => {
      const batch = createBatch({ status, currentQuantity: 9500 });
      expect(() => service.assertFeedable(batch)).toThrow(BadRequestException);
    });

    it('should throw when the batch is empty (currentQuantity = 0)', () => {
      const batch = createBatch({ status: BatchStatus.GROWING, currentQuantity: 0 });
      expect(() => service.assertFeedable(batch)).toThrow(BadRequestException);
    });

    it('should throw when currentQuantity is negative', () => {
      const batch = createBatch({ status: BatchStatus.GROWING, currentQuantity: -5 });
      expect(() => service.assertFeedable(batch)).toThrow(BadRequestException);
    });

    it('should prioritise the empty-batch error even for a feedable status', () => {
      const batch = createBatch({ status: BatchStatus.ACTIVE, currentQuantity: 0 });
      expect(() => service.assertFeedable(batch)).toThrow(/no live fish/);
    });
  });

  describe('calculateSGR', () => {
    it('should calculate SGR using natural log formula', () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const batch = createBatch({
        stockedAt: thirtyDaysAgo,
        actualHarvestDate: undefined,
        weight: {
          initial: { avgWeight: 50, totalBiomass: 500, measuredAt: thirtyDaysAgo },
          theoretical: {
            avgWeight: 0,
            totalBiomass: 0,
            lastCalculatedAt: new Date(),
            basedOnFCR: 0,
          },
          actual: {
            avgWeight: 100,
            totalBiomass: 950,
            lastMeasuredAt: now,
            sampleSize: 100,
            confidencePercent: 95,
          },
          variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
        },
      });
      // SGR = ((ln(100) - ln(50)) / 30) × 100 = (0.693 / 30) × 100 ≈ 2.31
      const sgr = service.calculateSGR(batch);
      expect(sgr).toBeGreaterThan(2);
      expect(sgr).toBeLessThan(3);
    });

    it('should return 0 when initial weight is 0', () => {
      const batch = createBatch({
        weight: {
          initial: { avgWeight: 0, totalBiomass: 0, measuredAt: new Date() },
          theoretical: {
            avgWeight: 0,
            totalBiomass: 0,
            lastCalculatedAt: new Date(),
            basedOnFCR: 0,
          },
          actual: {
            avgWeight: 100,
            totalBiomass: 1000,
            lastMeasuredAt: new Date(),
            sampleSize: 100,
            confidencePercent: 95,
          },
          variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
        },
      });
      expect(service.calculateSGR(batch)).toBe(0);
    });
  });

  describe('getDaysInProduction', () => {
    it('should calculate days from stocking to now', () => {
      const now = new Date('2025-05-11T00:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);

      try {
        const batch = createBatch({ stockedAt: new Date('2025-05-01T00:00:00.000Z') });
        expect(service.getDaysInProduction(batch)).toBe(10);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should use harvest date as end if batch is harvested', () => {
      const batch = createBatch({
        stockedAt: new Date('2025-01-01'),
        actualHarvestDate: new Date('2025-04-01'),
      });
      expect(service.getDaysInProduction(batch)).toBe(90);
    });
  });

  // ── Status & Classification ───────────────────────────────────────────

  describe('canTransitionTo', () => {
    it('should allow QUARANTINE → ACTIVE', () => {
      const batch = createBatch({ status: BatchStatus.QUARANTINE });
      expect(service.canTransitionTo(batch, BatchStatus.ACTIVE)).toBe(true);
    });

    it('should reject CLOSED → anything', () => {
      const batch = createBatch({ status: BatchStatus.CLOSED });
      expect(service.canTransitionTo(batch, BatchStatus.ACTIVE)).toBe(false);
      expect(service.canTransitionTo(batch, BatchStatus.GROWING)).toBe(false);
    });

    it('should allow GROWING → PRE_HARVEST', () => {
      const batch = createBatch({ status: BatchStatus.GROWING });
      expect(service.canTransitionTo(batch, BatchStatus.PRE_HARVEST)).toBe(true);
    });

    it('should reject ACTIVE → HARVESTED (must go through GROWING first)', () => {
      const batch = createBatch({ status: BatchStatus.ACTIVE });
      expect(service.canTransitionTo(batch, BatchStatus.HARVESTED)).toBe(false);
    });

    it('should allow FAILED → CLOSED (any failed batch can be closed)', () => {
      const batch = createBatch({ status: BatchStatus.FAILED });
      expect(service.canTransitionTo(batch, BatchStatus.CLOSED)).toBe(true);
    });
  });

  describe('isOperational', () => {
    it.each([
      BatchStatus.ACTIVE,
      BatchStatus.GROWING,
      BatchStatus.PRE_HARVEST,
      BatchStatus.HARVESTING,
    ])('should return true for %s', (status) => {
      expect(service.isOperational(createBatch({ status }))).toBe(true);
    });

    it.each([
      BatchStatus.QUARANTINE,
      BatchStatus.HARVESTED,
      BatchStatus.TRANSFERRED,
      BatchStatus.FAILED,
      BatchStatus.CLOSED,
    ])('should return false for %s', (status) => {
      expect(service.isOperational(createBatch({ status }))).toBe(false);
    });
  });

  describe('batch classification', () => {
    it('should identify cleaner fish batch', () => {
      const batch = createBatch({ batchType: BatchType.CLEANER_FISH });
      expect(service.isCleanerFishBatch(batch)).toBe(true);
      expect(service.isProductionBatch(batch)).toBe(false);
    });

    it('should identify production batch', () => {
      const batch = createBatch({ batchType: BatchType.PRODUCTION });
      expect(service.isProductionBatch(batch)).toBe(true);
      expect(service.isCleanerFishBatch(batch)).toBe(false);
    });
  });
});
