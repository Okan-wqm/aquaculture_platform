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

import { BatchLocation } from '../../../batch/entities/batch-location.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { TankOperation } from '../../../batch/entities/tank-operation.entity';
import { FeedingProgramTank } from '../../../feeding/entities/feeding-program-tank.entity';
import { FeedingProgram } from '../../../feeding/entities/feeding-program.entity';
import { FeedingRecord } from '../../../feeding/entities/feeding-record.entity';
import { Species } from '../../../species/entities/species.entity';
import { GrowthMeasurement } from '../../entities/growth-measurement.entity';
import { ProtocolRateService } from '../../../feeding-protocol/services/protocol-rate.service';
import { FCRCalculationService, FCRCalculationInput } from '../../services/fcr-calculation.service';

describe('FCRCalculationService', () => {
  let service: FCRCalculationService;
  let feedingRecordRepository: jest.Mocked<Repository<FeedingRecord>>;
  let growthMeasurementRepository: jest.Mocked<Repository<GrowthMeasurement>>;
  let batchRepository: jest.Mocked<Repository<Batch>>;

  // calculateCumulativeFCR now derives current biomass on read via
  // Batch.getCurrentBiomass (currentQuantity × effectiveAvgWeightG / 1000),
  // NOT from the latest growth-measurement snapshot. So mock batches must be
  // REAL Batch instances (so the method exists) with currentQuantity + an
  // actual avgWeight that produces the intended current biomass.
  //   currentBiomassKg = currentQuantity × actualAvgWeightG / 1000
  //   startBiomassKg   = initialQuantity × initialAvgWeightG / 1000
  const makeBatch = (params: {
    currentBiomassKg: number;
    startBiomassKg: number;
    initialQuantity?: number;
    batchNumber?: string;
  }): Batch => {
    const initialQuantity = params.initialQuantity ?? 10000;
    const currentQuantity = initialQuantity; // count fixed; vary avgWeight
    const initialAvgWeightG = (params.startBiomassKg * 1000) / initialQuantity;
    const actualAvgWeightG = (params.currentBiomassKg * 1000) / currentQuantity;
    return Object.assign(new Batch(), {
      id: 'batch-456',
      batchNumber: params.batchNumber ?? 'B-2024-001',
      initialQuantity,
      currentQuantity,
      weight: {
        initial: { avgWeight: initialAvgWeightG, totalBiomass: params.startBiomassKg, measuredAt: new Date() },
        theoretical: { avgWeight: 0, totalBiomass: 0, lastCalculatedAt: new Date(), basedOnFCR: 0 },
        actual: {
          avgWeight: actualAvgWeightG,
          totalBiomass: params.currentBiomassKg,
          lastMeasuredAt: new Date(),
          sampleSize: 100,
          confidencePercent: 95,
        },
        variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
      },
    });
  };

  const mockFeedingRecordRepository = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  // getTargetFCR v2 zinciri (P-14) ham SQL'i repository.manager.query üzerinden
  // atar — varsayılan boş sonuç: v2 ataması yok, zincir legacy dallara düşer.
  const mockManagerQuery = jest.fn();
  // W5 (FARM-LOW-291): trend analizi de toplu ham sorguya döndü — pencere
  // fonksiyonu tek çağrıda son 10 ölçümü batch başına getirir.
  const mockGrowthMeasurementQuery = jest.fn();
  const mockGrowthMeasurementRepository = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: { query: mockGrowthMeasurementQuery },
  };
  const mockBatchRepository = {
    findOne: jest.fn(),
    manager: { query: mockManagerQuery },
  };

  const mockSpeciesRepository = {
    findOne: jest.fn(),
  };

  const mockBatchLocationRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockFeedingProgramRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockFeedingProgramTankRepository = {
    find: jest.fn(),
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

  // Ayrı builder: TankOperation ledger sorgusu (net çıkan biyokütle).
  // Varsayılan 0 — ledger'ı umursamayan testler etkilenmez.
  const mockLedgerQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
  };

  const mockTankOperationRepository = {
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FCRCalculationService,
        // Saf servis — gerçek instance (band/matris çözümü specteki değerlerle sınanır).
        ProtocolRateService,
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
        {
          provide: getRepositoryToken(Species),
          useValue: mockSpeciesRepository,
        },
        {
          provide: getRepositoryToken(BatchLocation),
          useValue: mockBatchLocationRepository,
        },
        {
          provide: getRepositoryToken(FeedingProgram),
          useValue: mockFeedingProgramRepository,
        },
        {
          provide: getRepositoryToken(FeedingProgramTank),
          useValue: mockFeedingProgramTankRepository,
        },
        {
          provide: getRepositoryToken(TankOperation),
          useValue: mockTankOperationRepository,
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
    mockTankOperationRepository.createQueryBuilder.mockReturnValue(mockLedgerQueryBuilder);
    mockLedgerQueryBuilder.getRawOne.mockResolvedValue({ netRemovedKg: 0 });
    mockManagerQuery.mockResolvedValue([]);
    mockGrowthMeasurementQuery.mockResolvedValue([]);
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
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }),
      );

      const result = await service.calculatePeriodFCR(defaultInput);

      // FCR = 150kg / 100kg = 1.5
      expect(result.periodFCR).toBe(1.5);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should return warning when less than 2 measurements', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 50 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
      ]);

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Yetersiz büyüme ölçümü - en az 2 ölçüm gerekli');
    });

    it('should return warning for negative or zero growth', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 50 }]);

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
      // 510kg feed for 100kg growth = FCR 5.1
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 510 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 510 });
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }),
      );

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.periodFCR).toBe(5.1);
      expect(result.warnings.some((w) => w.includes('Anormal FCR'))).toBe(true);
    });

    it('should warn for abnormally low FCR', async () => {
      // 40kg feed for 100kg growth = FCR 0.4
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 40 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 40 });
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }),
      );

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.periodFCR).toBe(0.4);
      expect(result.warnings.some((w) => w.includes('Anormal FCR'))).toBe(true);
    });

    it('should include FCR analysis in result', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 150 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 200 });
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }),
      );

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

    it('should calculate cumulative FCR from batch start (derive-on-read biomass)', async () => {
      // 1000kg start, 1400kg current (derived from currentQuantity × avgWeight)
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1400, startBiomassKg: 1000 }),
      );

      // Total feed: 500kg
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 500 });

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      // FCR = 500 / 400 = 1.25
      expect(result.fcr).toBe(1.25);
      expect(result.totalFeed).toBe(500);
      expect(result.totalGrowth).toBe(400);
    });

    it('should respect endDate parameter', async () => {
      const endDate = new Date('2024-01-15');

      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }),
      );

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });

      await service.calculateCumulativeFCR(batchId, tenantId, endDate);

      // Verify andWhere was called with endDate
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('fr.feedingDate <= :endDate', {
        endDate,
      });
    });

    it('should return 0 FCR when no growth', async () => {
      // current biomass == start biomass (1000kg) → zero realized growth
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1000, startBiomassKg: 1000 }),
      );

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 100 });

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.fcr).toBe(0);
      expect(result.totalGrowth).toBe(0);
    });

    it('should add back biomass removed by mortality/cull/harvest to realized growth', async () => {
      // 1000kg start, 1400kg current still in the water (derive-on-read)
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1400, startBiomassKg: 1000 }),
      );

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 600 });
      // …but 200kg left the system (mortality + partial harvest). Those fish
      // ate feed and grew before exiting — naive (current − start) hides that
      // growth and inflates FCR (600/400=1.5 instead of the true 600/600=1.0).
      mockLedgerQueryBuilder.getRawOne.mockResolvedValue({ netRemovedKg: 200 });

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.totalGrowth).toBe(600); // (1400 + 200) − 1000
      expect(result.removedBiomassKg).toBe(200);
      expect(result.fcr).toBe(1.0);
    });

    it('should subtract transfer-in biomass (entered without consuming feed)', async () => {
      // 1000kg start, 1400kg current (derive-on-read)
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1400, startBiomassKg: 1000 }),
      );

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });
      // Net negative ledger: 100kg more came IN via transfer than left.
      // That biomass did not grow on this batch's feed.
      mockLedgerQueryBuilder.getRawOne.mockResolvedValue({ netRemovedKg: -100 });

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.totalGrowth).toBe(300); // (1400 − 100) − 1000
      expect(result.fcr).toBe(1.0);
    });

    it('should apply endDate to the tank-operation ledger query', async () => {
      const endDate = new Date('2024-01-15');

      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }),
      );

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });

      await service.calculateCumulativeFCR(batchId, tenantId, endDate);

      expect(mockLedgerQueryBuilder.andWhere).toHaveBeenCalledWith(
        'op.operationDate <= :endDate',
        { endDate },
      );
    });
  });

  describe('analyzeFCRTrend', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return stable trend when insufficient data', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.5 } },
        { batchId, fcrAnalysis: { periodFCR: 1.4 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('stable');
      expect(result.recommendations).toContain('Yeterli veri yok - daha fazla ölçüm gerekli');
    });

    it('should detect improving trend (decreasing FCR)', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.8, cumulativeFCR: 1.8 } },
        { batchId, fcrAnalysis: { periodFCR: 1.6, cumulativeFCR: 1.7 } },
        { batchId, fcrAnalysis: { periodFCR: 1.4, cumulativeFCR: 1.6 } },
        { batchId, fcrAnalysis: { periodFCR: 1.2, cumulativeFCR: 1.5 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('improving');
      expect(result.slope).toBeLessThan(0);
    });

    it('should detect declining trend (increasing FCR)', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.2, cumulativeFCR: 1.2 } },
        { batchId, fcrAnalysis: { periodFCR: 1.4, cumulativeFCR: 1.3 } },
        { batchId, fcrAnalysis: { periodFCR: 1.6, cumulativeFCR: 1.4 } },
        { batchId, fcrAnalysis: { periodFCR: 1.8, cumulativeFCR: 1.5 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('declining');
      expect(result.slope).toBeGreaterThan(0);
    });

    it('should include recommendations for declining trend', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.2 } },
        { batchId, fcrAnalysis: { periodFCR: 1.5 } },
        { batchId, fcrAnalysis: { periodFCR: 1.8 } },
        { batchId, fcrAnalysis: { periodFCR: 2.1 } },
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
      // 1000kg start, 1200kg current → 200kg realized growth (derive-on-read)
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }),
      );
    });

    it('should rate excellent performance when FCR is 10%+ below target', async () => {
      // FCR 1.3 vs target 1.5 = -13.3% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 260 });

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('excellent');
      expect(result.varianceFromTarget).toBeLessThan(-10);
    });

    it('should rate good performance when FCR is at or below target', async () => {
      // FCR 1.45 vs target 1.5 = -3.3% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 290 });

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('good');
    });

    it('should rate poor performance when FCR is 20%+ above target', async () => {
      // FCR 2.0 vs target 1.5 = +33% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 400 });

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('poor');
      expect(result.varianceFromTarget).toBeGreaterThan(20);
    });

    it('should compare against industry average', async () => {
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });

      const result = await service.compareFCR(batchId, tenantId, 'rainbow_trout');

      expect(result.industryAvgFCR).toBe(1.1); // Rainbow trout industry avg
      expect(result.varianceFromIndustry).toBeDefined();
    });
  });

  describe('detectFCRAnomalies', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    beforeEach(() => {
      // 1000kg start, 1200kg current → 200kg realized growth (derive-on-read)
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }),
      );
      mockGrowthMeasurementRepository.find.mockResolvedValue([]);
    });

    it('should detect critically high FCR', async () => {
      // FCR > 3 is critical
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 700 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some((a) => a.includes('Kritik'))).toBe(true);
    });

    it('should detect suspiciously low FCR', async () => {
      // FCR < 0.7 is suspicious
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 100 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some((a) => a.includes('çok düşük'))).toBe(true);
    });

    it('should detect significant variance from target', async () => {
      // FCR 2.1 vs target 1.5 = 40% variance
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 420 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some((a) => a.includes('sapma'))).toBe(true);
    });

    it('should return no anomalies for normal FCR', async () => {
      // FCR 1.5 is normal
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(false);
      expect(result.anomalies).toHaveLength(0);
    });
  });

  describe('getTargetFCR — P-14 v2 protokol zinciri (compareFCR üzerinden)', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    // makeBatch 120g ortalama üretir (1200kg / 10000 adet) — band [0, 1e6) kapsar.
    const v2Row = (params?: {
      overrides?: Record<string, unknown>;
      fcrSource?: string;
      fcrMatrix?: { temperatures: number[]; weights: number[]; fcrValues: number[][] } | null;
    }): Record<string, unknown> => ({
      overrides: params?.overrides ?? {},
      bands: [
        {
          minWeightG: 0,
          maxWeightG: 1000000,
          feedId: 'feed-1',
          feedCode: 'F1',
          feedName: 'Starter F1',
          feedingRatePercent: 2,
          expectedFcr: 1.2,
        },
      ],
      settings: {
        autoTransition: true,
        transitionBufferG: 10,
        growthApplicationMode: 'per_meal',
        underfeedAlertThresholdPercent: 15,
        fcrSource: params?.fcrSource ?? 'band',
      },
      fcrMatrix: params?.fcrMatrix ?? null,
    });

    beforeEach(() => {
      // 1000kg start, 1200kg current → cumulative FCR 300/200 = 1.5.
      mockBatchRepository.findOne.mockResolvedValue(
        Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
          tenantId,
        }),
      );
      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });
    });

    it('aktif v2 ataması varken hedef FCR banddan gelir ve legacy program dalı HİÇ sorgulanmaz', async () => {
      mockManagerQuery.mockResolvedValueOnce([v2Row()]);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.targetFCR).toBe(1.2);
      // Zincir sırası pinli: v2 çözüldüyse legacy FeedingProgram yoluna inilmez.
      expect(mockBatchLocationRepository.findOne).not.toHaveBeenCalled();
      expect(mockFeedingProgramTankRepository.findOne).not.toHaveBeenCalled();
    });

    it('ünite fcrOverrides girdisi band varsayılanını ezer (OVERRIDE önceliği)', async () => {
      mockManagerQuery.mockResolvedValueOnce([
        v2Row({ overrides: { fcrOverrides: [{ feedId: 'feed-1', expectedFcr: 1.05 }] } }),
      ]);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.targetFCR).toBe(1.05);
    });

    it('fcrSource=feed protokolde band yeminin FCR matrisi ağırlık ekseninde interpolasyonla çözülür', async () => {
      mockManagerQuery
        .mockResolvedValueOnce([v2Row({ fcrSource: 'feed' })])
        .mockResolvedValueOnce([
          {
            matrix: {
              temperatures: [10],
              weights: [100, 200],
              rates: [[2.5, 2.0]],
              fcrMatrix: [[1.0, 1.4]],
            },
          },
        ]);

      const result = await service.compareFCR(batchId, tenantId);

      // 120g: wFrac = (120−100)/(200−100) = 0.2 → 1.0 + 0.4×0.2 = 1.08.
      expect(result.targetFCR).toBeCloseTo(1.08, 10);
      expect(mockManagerQuery).toHaveBeenCalledTimes(2);
      expect(String(mockManagerQuery.mock.calls[1]?.[0])).toContain('feedingMatrix2D');
    });

    it('v2 ataması yokken zincir species targetFCR dalına düşer', async () => {
      mockBatchRepository.findOne.mockResolvedValue(
        Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
          tenantId,
          species: { growthParameters: { targetFCR: 1.35 } },
        }),
      );

      const result = await service.compareFCR(batchId, tenantId);

      expect(mockManagerQuery).toHaveBeenCalledTimes(1);
      expect(result.targetFCR).toBe(1.35);
    });

    it('kullanıcı override (batch.fcr.target) her şeyden önce gelir — v2 sorgusu atılmaz', async () => {
      mockBatchRepository.findOne.mockResolvedValue(
        Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
          tenantId,
          fcr: { isUserOverride: true, target: 2.0 },
        }),
      );

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.targetFCR).toBe(2.0);
      expect(mockManagerQuery).not.toHaveBeenCalled();
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
      mockBatchRepository.findOne.mockResolvedValue(
        makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000, batchNumber: 'B-2024-001' }),
      );

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, fcrAnalysis: { periodFCR: 1.4 } },
        { id: '2', estimatedBiomass: 1100, fcrAnalysis: { periodFCR: 1.5 } },
        { id: '3', estimatedBiomass: 1200, fcrAnalysis: { periodFCR: 1.6 } },
      ]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ totalFeed: 300 });

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
