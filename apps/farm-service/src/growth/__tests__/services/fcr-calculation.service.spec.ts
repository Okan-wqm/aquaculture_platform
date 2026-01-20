/**
 * FCR Calculation Service Unit Tests
 *
 * Feed Conversion Ratio (FCR) hesaplama servisinin kapsamlı testleri.
 *
 * @module Growth/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { FCRCalculationService, FCRCalculationInput } from '../../services/fcr-calculation.service';
import { FeedingRecord } from '../../../feeding/entities/feeding-record.entity';
import { GrowthMeasurement } from '../../entities/growth-measurement.entity';
import { Batch } from '../../../batch/entities/batch.entity';

describe('FCRCalculationService', () => {
  let service: FCRCalculationService;
  let feedingRecordRepository: jest.Mocked<Repository<FeedingRecord>>;
  let growthMeasurementRepository: jest.Mocked<Repository<GrowthMeasurement>>;
  let batchRepository: jest.Mocked<Repository<Batch>>;

  const mockFeedingRecordRepository = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockGrowthMeasurementRepository = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockBatchRepository = {
    findOne: jest.fn(),
  };

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
    getOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FCRCalculationService,
        {
          provide: getRepositoryToken(FeedingRecord),
          useValue: mockFeedingRecordRepository,
        },
        {
          provide: getRepositoryToken(GrowthMeasurement),
          useValue: mockGrowthMeasurementRepository,
        },
        {
          provide: getRepositoryToken(Batch),
          useValue: mockBatchRepository,
        },
      ],
    }).compile();

    service = module.get<FCRCalculationService>(FCRCalculationService);
    feedingRecordRepository = module.get(getRepositoryToken(FeedingRecord));
    growthMeasurementRepository = module.get(getRepositoryToken(GrowthMeasurement));
    batchRepository = module.get(getRepositoryToken(Batch));

    jest.clearAllMocks();

    // Setup default query builder mocks
    mockFeedingRecordRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    mockGrowthMeasurementRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  describe('calculatePeriodFCR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';
    const startDate = new Date('2024-01-01');
    const endDate = new Date('2024-01-31');

    const defaultInput: FCRCalculationInput = {
      batchId,
      tenantId,
      startDate,
      endDate,
      targetFCR: 1.5,
    };

    it('should calculate FCR correctly for valid data', async () => {
      // Feeding records: total 150kg feed
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 50 },
        { id: '2', actualAmount: 50 },
        { id: '3', actualAmount: 50 },
      ]);

      // Growth measurements: 1000kg start, 1100kg end = 100kg growth
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      // Mock cumulative calculation
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 200 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1100 });
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100, // 100g = 1000kg biomass
      });

      const result = await service.calculatePeriodFCR(defaultInput);

      // FCR = 150kg / 100kg = 1.5
      expect(result.periodFCR).toBe(1.5);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should return warning when less than 2 measurements', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 50 },
      ]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
      ]);

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Yetersiz büyüme ölçümü - en az 2 ölçüm gerekli');
    });

    it('should return warning for negative or zero growth', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 50 },
      ]);

      // No growth - same biomass
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1000, measurementDate: endDate },
      ]);

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Negatif veya sıfır büyüme tespit edildi');
    });

    it('should warn for abnormally high FCR', async () => {
      // 500kg feed for 100kg growth = FCR 5.0
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 500 },
      ]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 500 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1100 });
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100,
      });

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.periodFCR).toBe(5);
      expect(result.warnings.some(w => w.includes('Anormal FCR'))).toBe(true);
    });

    it('should warn for abnormally low FCR', async () => {
      // 40kg feed for 100kg growth = FCR 0.4
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 40 },
      ]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 40 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1100 });
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100,
      });

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.periodFCR).toBe(0.4);
      expect(result.warnings.some(w => w.includes('Anormal FCR'))).toBe(true);
    });

    it('should include FCR analysis in result', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 150 },
      ]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 200 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1100 });
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100,
      });

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.analysis).toBeDefined();
      expect(result.analysis.periodFeedGiven).toBe(150);
      expect(result.analysis.periodGrowth).toBe(100);
      expect(result.analysis.periodFCR).toBe(1.5);
      expect(result.analysis.targetFCR).toBe(1.5);
    });
  });

  describe('calculateCumulativeFCR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return zeros when batch not found', async () => {
      mockBatchRepository.findOne.mockResolvedValue(null);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.fcr).toBe(0);
      expect(result.totalFeed).toBe(0);
      expect(result.totalGrowth).toBe(0);
    });

    it('should calculate cumulative FCR from batch start', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100, // 100g = 1000kg start biomass
      });

      // Total feed: 500kg
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 500 });
      // Current biomass: 1400kg (400kg growth)
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1400 });

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      // FCR = 500 / 400 = 1.25
      expect(result.fcr).toBe(1.25);
      expect(result.totalFeed).toBe(500);
      expect(result.totalGrowth).toBe(400);
    });

    it('should respect endDate parameter', async () => {
      const endDate = new Date('2024-01-15');

      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100,
      });

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      await service.calculateCumulativeFCR(batchId, tenantId, endDate);

      // Verify andWhere was called with endDate
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'fr.feedingDate <= :endDate',
        { endDate }
      );
    });

    it('should return 0 FCR when no growth', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100, // 1000kg start
      });

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 100 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1000 }); // Same as start

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.fcr).toBe(0);
      expect(result.totalGrowth).toBe(0);
    });
  });

  describe('analyzeFCRTrend', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return stable trend when insufficient data', async () => {
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', fcrAnalysis: { periodFCR: 1.5 } },
        { id: '2', fcrAnalysis: { periodFCR: 1.4 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('stable');
      expect(result.recommendations).toContain('Yeterli veri yok - daha fazla ölçüm gerekli');
    });

    it('should detect improving trend (decreasing FCR)', async () => {
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', fcrAnalysis: { periodFCR: 1.8, cumulativeFCR: 1.8 }, measurementDate: new Date('2024-01-01') },
        { id: '2', fcrAnalysis: { periodFCR: 1.6, cumulativeFCR: 1.7 }, measurementDate: new Date('2024-01-08') },
        { id: '3', fcrAnalysis: { periodFCR: 1.4, cumulativeFCR: 1.6 }, measurementDate: new Date('2024-01-15') },
        { id: '4', fcrAnalysis: { periodFCR: 1.2, cumulativeFCR: 1.5 }, measurementDate: new Date('2024-01-22') },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('improving');
      expect(result.slope).toBeLessThan(0);
    });

    it('should detect declining trend (increasing FCR)', async () => {
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', fcrAnalysis: { periodFCR: 1.2, cumulativeFCR: 1.2 }, measurementDate: new Date('2024-01-01') },
        { id: '2', fcrAnalysis: { periodFCR: 1.4, cumulativeFCR: 1.3 }, measurementDate: new Date('2024-01-08') },
        { id: '3', fcrAnalysis: { periodFCR: 1.6, cumulativeFCR: 1.4 }, measurementDate: new Date('2024-01-15') },
        { id: '4', fcrAnalysis: { periodFCR: 1.8, cumulativeFCR: 1.5 }, measurementDate: new Date('2024-01-22') },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('declining');
      expect(result.slope).toBeGreaterThan(0);
    });

    it('should include recommendations for declining trend', async () => {
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', fcrAnalysis: { periodFCR: 1.2 }, measurementDate: new Date('2024-01-01') },
        { id: '2', fcrAnalysis: { periodFCR: 1.5 }, measurementDate: new Date('2024-01-08') },
        { id: '3', fcrAnalysis: { periodFCR: 1.8 }, measurementDate: new Date('2024-01-15') },
        { id: '4', fcrAnalysis: { periodFCR: 2.1 }, measurementDate: new Date('2024-01-22') },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.recommendations).toContain('Yemleme programını gözden geçirin');
      expect(result.recommendations).toContain('Su kalitesi parametrelerini kontrol edin');
    });
  });

  describe('compareFCR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    beforeEach(() => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100,
      });
    });

    it('should rate excellent performance when FCR is 10%+ below target', async () => {
      // FCR 1.3 vs target 1.5 = -13.3% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 260 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('excellent');
      expect(result.varianceFromTarget).toBeLessThan(-10);
    });

    it('should rate good performance when FCR is at or below target', async () => {
      // FCR 1.45 vs target 1.5 = -3.3% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 290 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('good');
    });

    it('should rate poor performance when FCR is 20%+ above target', async () => {
      // FCR 2.0 vs target 1.5 = +33% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 400 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('poor');
      expect(result.varianceFromTarget).toBeGreaterThan(20);
    });

    it('should compare against industry average', async () => {
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.compareFCR(batchId, tenantId, 'rainbow_trout');

      expect(result.industryAvgFCR).toBe(1.1); // Rainbow trout industry avg
      expect(result.varianceFromIndustry).toBeDefined();
    });
  });

  describe('detectFCRAnomalies', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    beforeEach(() => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        stockingQuantity: 10000,
        stockingWeight: 100,
      });
      mockGrowthMeasurementRepository.find.mockResolvedValue([]);
    });

    it('should detect critically high FCR', async () => {
      // FCR > 3 is critical
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 700 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some(a => a.includes('Kritik'))).toBe(true);
    });

    it('should detect suspiciously low FCR', async () => {
      // FCR < 0.7 is suspicious
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 100 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some(a => a.includes('çok düşük'))).toBe(true);
    });

    it('should detect significant variance from target', async () => {
      // FCR 2.1 vs target 1.5 = 40% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 420 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some(a => a.includes('sapma'))).toBe(true);
    });

    it('should return no anomalies for normal FCR', async () => {
      // FCR 1.5 is normal
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(false);
      expect(result.anomalies).toHaveLength(0);
    });
  });

  describe('getBatchFCRSummary', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return null when batch not found', async () => {
      mockBatchRepository.findOne.mockResolvedValue(null);

      const result = await service.getBatchFCRSummary(batchId, tenantId);

      expect(result).toBeNull();
    });

    it('should return comprehensive summary', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        batchCode: 'B-2024-001',
        stockingQuantity: 10000,
        stockingWeight: 100,
      });

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, fcrAnalysis: { periodFCR: 1.4 } },
        { id: '2', estimatedBiomass: 1100, fcrAnalysis: { periodFCR: 1.5 } },
        { id: '3', estimatedBiomass: 1200, fcrAnalysis: { periodFCR: 1.6 } },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });
      mockQueryBuilder.getOne.mockResolvedValue({ estimatedBiomass: 1200 });

      const result = await service.getBatchFCRSummary(batchId, tenantId);

      expect(result).not.toBeNull();
      expect(result!.batchId).toBe(batchId);
      expect(result!.batchCode).toBe('B-2024-001');
      expect(result!.measurementCount).toBe(3);
      expect(result!.bestFCR).toBe(1.4);
      expect(result!.worstFCR).toBe(1.6);
      expect(result!.avgFCR).toBeCloseTo(1.5, 1);
    });
  });
});
