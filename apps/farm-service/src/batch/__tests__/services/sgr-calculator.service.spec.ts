/**
 * SGR Calculator Service Unit Tests
 *
 * Specific Growth Rate (SGR) hesaplama servisinin kapsamlı testleri.
 *
 * @module Batch/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SGRCalculatorService, SGRResult, SGRTrend } from '../../services/sgr-calculator.service';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';

describe('SGRCalculatorService', () => {
  let service: SGRCalculatorService;
  let measurementRepository: jest.Mocked<Repository<GrowthMeasurement>>;

  const mockMeasurementRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SGRCalculatorService,
        {
          provide: getRepositoryToken(GrowthMeasurement),
          useValue: mockMeasurementRepository,
        },
      ],
    }).compile();

    service = module.get<SGRCalculatorService>(SGRCalculatorService);
    measurementRepository = module.get(getRepositoryToken(GrowthMeasurement));

    jest.clearAllMocks();
  });

  describe('calculateSGR', () => {
    it('should calculate SGR correctly for normal growth', () => {
      // SGR = (ln(finalWeight) - ln(initialWeight)) / days * 100
      const initialWeight = 100; // grams
      const finalWeight = 150; // grams
      const days = 14;

      const result = service.calculateSGR(initialWeight, finalWeight, days);

      // Expected: (ln(150) - ln(100)) / 14 * 100 = (5.01 - 4.61) / 14 * 100 = 2.89%
      expect(result).toBeCloseTo(2.89, 1);
    });

    it('should return 0 for zero or negative initial weight', () => {
      expect(service.calculateSGR(0, 100, 14)).toBe(0);
      expect(service.calculateSGR(-10, 100, 14)).toBe(0);
    });

    it('should return 0 for zero or negative final weight', () => {
      expect(service.calculateSGR(100, 0, 14)).toBe(0);
      expect(service.calculateSGR(100, -10, 14)).toBe(0);
    });

    it('should return 0 for zero or negative days', () => {
      expect(service.calculateSGR(100, 150, 0)).toBe(0);
      expect(service.calculateSGR(100, 150, -5)).toBe(0);
    });

    it('should handle weight loss (negative SGR)', () => {
      const initialWeight = 150;
      const finalWeight = 100;
      const days = 14;

      const result = service.calculateSGR(initialWeight, finalWeight, days);

      expect(result).toBeLessThan(0);
      expect(result).toBeCloseTo(-2.89, 1);
    });

    it('should calculate correctly for very small weight change', () => {
      const initialWeight = 100;
      const finalWeight = 101;
      const days = 7;

      const result = service.calculateSGR(initialWeight, finalWeight, days);

      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('should calculate correctly for rapid growth', () => {
      const initialWeight = 50;
      const finalWeight = 200; // 4x growth
      const days = 30;

      const result = service.calculateSGR(initialWeight, finalWeight, days);

      // Expected: (ln(200) - ln(50)) / 30 * 100 = 4.62%
      expect(result).toBeCloseTo(4.62, 1);
    });
  });

  describe('rateSGR', () => {
    it('should rate SGR >= 3 as excellent', () => {
      expect(service.rateSGR(3.5)).toBe('excellent');
      expect(service.rateSGR(4.0)).toBe('excellent');
      expect(service.rateSGR(3.0)).toBe('excellent');
    });

    it('should rate SGR between 2 and 3 as good', () => {
      expect(service.rateSGR(2.5)).toBe('good');
      expect(service.rateSGR(2.0)).toBe('good');
      expect(service.rateSGR(2.99)).toBe('good');
    });

    it('should rate SGR between 1 and 2 as average', () => {
      expect(service.rateSGR(1.5)).toBe('average');
      expect(service.rateSGR(1.0)).toBe('average');
      expect(service.rateSGR(1.99)).toBe('average');
    });

    it('should rate SGR between 0 and 1 as below_average', () => {
      expect(service.rateSGR(0.5)).toBe('below_average');
      expect(service.rateSGR(0.1)).toBe('below_average');
      expect(service.rateSGR(0.99)).toBe('below_average');
    });

    it('should rate negative SGR as poor', () => {
      expect(service.rateSGR(-0.5)).toBe('poor');
      expect(service.rateSGR(-2.0)).toBe('poor');
      expect(service.rateSGR(0)).toBe('poor');
    });
  });

  describe('getBatchSGR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return null when no measurements exist', async () => {
      mockMeasurementRepository.find.mockResolvedValue([]);

      const result = await service.getBatchSGR(batchId, tenantId);

      expect(result).toBeNull();
      expect(mockMeasurementRepository.find).toHaveBeenCalledWith({
        where: { batchId, tenantId },
        order: { measurementDate: 'ASC' },
      });
    });

    it('should return null when only one measurement exists', async () => {
      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date() },
      ]);

      const result = await service.getBatchSGR(batchId, tenantId);

      expect(result).toBeNull();
    });

    it('should calculate SGR between first and last measurement', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-15'); // 14 days later

      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: startDate },
        { id: '2', averageWeight: 120, measurementDate: new Date('2024-01-08') },
        { id: '3', averageWeight: 150, measurementDate: endDate },
      ]);

      const result = await service.getBatchSGR(batchId, tenantId);

      expect(result).not.toBeNull();
      expect(result!.sgr).toBeCloseTo(2.89, 1);
      expect(result!.initialWeight).toBe(100);
      expect(result!.finalWeight).toBe(150);
      expect(result!.daysBetween).toBe(14);
    });

    it('should include rating in result', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-15');

      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: startDate },
        { id: '2', averageWeight: 150, measurementDate: endDate },
      ]);

      const result = await service.getBatchSGR(batchId, tenantId);

      expect(result!.rating).toBeDefined();
      expect(['excellent', 'good', 'average', 'below_average', 'poor']).toContain(result!.rating);
    });
  });

  describe('getSGRTrend', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return null when less than 3 measurements', async () => {
      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 120, measurementDate: new Date('2024-01-08') },
      ]);

      const result = await service.getSGRTrend(batchId, tenantId);

      expect(result).toBeNull();
    });

    it('should detect improving trend', async () => {
      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 110, measurementDate: new Date('2024-01-08') }, // SGR ~1.36%
        { id: '3', averageWeight: 130, measurementDate: new Date('2024-01-15') }, // SGR ~2.39%
        { id: '4', averageWeight: 165, measurementDate: new Date('2024-01-22') }, // SGR ~3.39%
      ]);

      const result = await service.getSGRTrend(batchId, tenantId);

      expect(result).not.toBeNull();
      expect(result!.trend).toBe('improving');
    });

    it('should detect declining trend', async () => {
      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 140, measurementDate: new Date('2024-01-08') }, // High SGR
        { id: '3', averageWeight: 160, measurementDate: new Date('2024-01-15') }, // Lower SGR
        { id: '4', averageWeight: 170, measurementDate: new Date('2024-01-22') }, // Even lower
      ]);

      const result = await service.getSGRTrend(batchId, tenantId);

      expect(result).not.toBeNull();
      expect(result!.trend).toBe('declining');
    });

    it('should detect stable trend', async () => {
      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 115, measurementDate: new Date('2024-01-08') },
        { id: '3', averageWeight: 132, measurementDate: new Date('2024-01-15') },
        { id: '4', averageWeight: 152, measurementDate: new Date('2024-01-22') },
      ]);

      const result = await service.getSGRTrend(batchId, tenantId);

      expect(result).not.toBeNull();
      expect(result!.trend).toBe('stable');
    });

    it('should include period SGR values', async () => {
      mockMeasurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 120, measurementDate: new Date('2024-01-08') },
        { id: '3', averageWeight: 145, measurementDate: new Date('2024-01-15') },
      ]);

      const result = await service.getSGRTrend(batchId, tenantId);

      expect(result!.periodSGRs).toBeDefined();
      expect(result!.periodSGRs.length).toBe(2);
      expect(result!.avgSGR).toBeDefined();
    });
  });

  describe('compareToTarget', () => {
    it('should calculate variance from target correctly', () => {
      const actualSGR = 2.5;
      const targetSGR = 3.0;

      const result = service.compareToTarget(actualSGR, targetSGR);

      expect(result.actual).toBe(2.5);
      expect(result.target).toBe(3.0);
      expect(result.variance).toBeCloseTo(-0.5, 2);
      expect(result.variancePercent).toBeCloseTo(-16.67, 1);
    });

    it('should show positive variance when exceeding target', () => {
      const actualSGR = 3.5;
      const targetSGR = 3.0;

      const result = service.compareToTarget(actualSGR, targetSGR);

      expect(result.variance).toBeCloseTo(0.5, 2);
      expect(result.variancePercent).toBeCloseTo(16.67, 1);
    });

    it('should handle zero target', () => {
      const result = service.compareToTarget(2.5, 0);

      expect(result.variancePercent).toBe(0);
    });
  });

  describe('calculateDailyGrowthRate', () => {
    it('should calculate ADG correctly', () => {
      const initialWeight = 100;
      const finalWeight = 150;
      const days = 10;

      const adg = service.calculateDailyGrowthRate(initialWeight, finalWeight, days);

      expect(adg).toBe(5); // (150-100)/10 = 5 g/day
    });

    it('should return 0 for zero days', () => {
      const adg = service.calculateDailyGrowthRate(100, 150, 0);
      expect(adg).toBe(0);
    });

    it('should handle negative growth', () => {
      const adg = service.calculateDailyGrowthRate(150, 100, 10);
      expect(adg).toBe(-5);
    });
  });
});
