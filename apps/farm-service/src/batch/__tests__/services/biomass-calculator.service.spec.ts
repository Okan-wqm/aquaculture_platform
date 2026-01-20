/**
 * Biomass Calculator Service Unit Tests
 *
 * Biyokütle hesaplama servisinin kapsamlı testleri.
 *
 * @module Batch/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BiomassCalculatorService,
  BiomassResult,
  TankDensityAnalysis,
} from '../../services/biomass-calculator.service';
import { Batch } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';

describe('BiomassCalculatorService', () => {
  let service: BiomassCalculatorService;
  let batchRepository: jest.Mocked<Repository<Batch>>;
  let tankBatchRepository: jest.Mocked<Repository<TankBatch>>;
  let tankRepository: jest.Mocked<Repository<Tank>>;
  let measurementRepository: jest.Mocked<Repository<GrowthMeasurement>>;

  const mockBatchRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockTankBatchRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
  };

  const mockTankRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockMeasurementRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BiomassCalculatorService,
        {
          provide: getRepositoryToken(Batch),
          useValue: mockBatchRepository,
        },
        {
          provide: getRepositoryToken(TankBatch),
          useValue: mockTankBatchRepository,
        },
        {
          provide: getRepositoryToken(Tank),
          useValue: mockTankRepository,
        },
        {
          provide: getRepositoryToken(GrowthMeasurement),
          useValue: mockMeasurementRepository,
        },
      ],
    }).compile();

    service = module.get<BiomassCalculatorService>(BiomassCalculatorService);
    batchRepository = module.get(getRepositoryToken(Batch));
    tankBatchRepository = module.get(getRepositoryToken(TankBatch));
    tankRepository = module.get(getRepositoryToken(Tank));
    measurementRepository = module.get(getRepositoryToken(GrowthMeasurement));

    jest.clearAllMocks();
  });

  describe('calculateBiomass', () => {
    it('should calculate biomass correctly', () => {
      // Biomass (kg) = Quantity * Average Weight (g) / 1000
      const quantity = 10000;
      const avgWeightG = 250;

      const result = service.calculateBiomass(quantity, avgWeightG);

      expect(result).toBe(2500); // 10000 * 250 / 1000 = 2500 kg
    });

    it('should return 0 for zero quantity', () => {
      const result = service.calculateBiomass(0, 250);
      expect(result).toBe(0);
    });

    it('should return 0 for negative quantity', () => {
      const result = service.calculateBiomass(-100, 250);
      expect(result).toBe(0);
    });

    it('should return 0 for zero weight', () => {
      const result = service.calculateBiomass(10000, 0);
      expect(result).toBe(0);
    });

    it('should return 0 for negative weight', () => {
      const result = service.calculateBiomass(10000, -50);
      expect(result).toBe(0);
    });

    it('should handle very large numbers', () => {
      const quantity = 1000000;
      const avgWeightG = 5000;

      const result = service.calculateBiomass(quantity, avgWeightG);

      expect(result).toBe(5000000); // 5 million kg
    });

    it('should handle small fish', () => {
      const quantity = 50000;
      const avgWeightG = 5; // 5 gram fry

      const result = service.calculateBiomass(quantity, avgWeightG);

      expect(result).toBe(250); // 250 kg
    });
  });

  describe('getBatchBiomass', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should throw error when batch not found', async () => {
      mockBatchRepository.findOne.mockResolvedValue(null);

      await expect(service.getBatchBiomass(batchId, tenantId))
        .rejects.toThrow(`Batch ${batchId} bulunamadı`);
    });

    it('should return measured biomass with high confidence for recent measurement', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 3); // 3 days ago

      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: { growthParameters: { avgDailyGrowth: 2 } },
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue({
        id: 'measurement-1',
        averageWeight: 250,
        measurementDate: recentDate,
      });

      const result = await service.getBatchBiomass(batchId, tenantId);

      expect(result.biomassKg).toBe(2500); // 10000 * 250 / 1000
      expect(result.quantity).toBe(10000);
      expect(result.avgWeightG).toBe(250);
      expect(result.method).toBe('measured');
      expect(result.confidence).toBe('high');
      expect(result.lastMeasurementDate).toEqual(recentDate);
    });

    it('should return estimated biomass with medium confidence for older measurement', async () => {
      const olderDate = new Date();
      olderDate.setDate(olderDate.getDate() - 14); // 14 days ago

      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: { growthParameters: { avgDailyGrowth: 2 } },
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue({
        id: 'measurement-1',
        averageWeight: 220,
        measurementDate: olderDate,
      });

      const result = await service.getBatchBiomass(batchId, tenantId);

      // Weight should be estimated: 220 + (2 * 14) = 248
      expect(result.avgWeightG).toBeCloseTo(248, 0);
      expect(result.method).toBe('estimated');
      expect(result.confidence).toBe('medium');
    });

    it('should return estimated biomass with low confidence for very old measurement', async () => {
      const veryOldDate = new Date();
      veryOldDate.setDate(veryOldDate.getDate() - 30); // 30 days ago

      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: { growthParameters: { avgDailyGrowth: 2 } },
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue({
        id: 'measurement-1',
        averageWeight: 180,
        measurementDate: veryOldDate,
      });

      const result = await service.getBatchBiomass(batchId, tenantId);

      expect(result.method).toBe('estimated');
      expect(result.confidence).toBe('low');
    });

    it('should return calculated biomass when no measurement exists', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: { growthParameters: { avgDailyGrowth: 2 } },
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue(null);

      const result = await service.getBatchBiomass(batchId, tenantId);

      expect(result.avgWeightG).toBe(200);
      expect(result.method).toBe('calculated');
      expect(result.confidence).toBe('low');
      expect(result.lastMeasurementDate).toBeUndefined();
    });

    it('should use default daily growth when species data not available', async () => {
      const olderDate = new Date();
      olderDate.setDate(olderDate.getDate() - 14);

      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: null,
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue({
        id: 'measurement-1',
        averageWeight: 220,
        measurementDate: olderDate,
      });

      const result = await service.getBatchBiomass(batchId, tenantId);

      // Default daily growth is 1g
      expect(result.avgWeightG).toBeCloseTo(234, 0); // 220 + (1 * 14)
    });
  });

  describe('analyzeTankDensity', () => {
    const tenantId = 'tenant-123';
    const tankId = 'tank-789';

    it('should throw error when tank not found', async () => {
      mockTankRepository.findOne.mockResolvedValue(null);

      await expect(service.analyzeTankDensity(tankId, tenantId))
        .rejects.toThrow(`Tank ${tankId} bulunamadı`);
    });

    it('should return optimal status for normal density', async () => {
      mockTankRepository.findOne.mockResolvedValue({
        id: tankId,
        tenantId,
        tankCode: 'T-001',
        volumeM3: 100,
        maxDensityKgM3: 25,
        optimalDensityMinKgM3: 10,
        optimalDensityMaxKgM3: 20,
        isDeleted: false,
      });

      mockTankBatchRepository.findOne.mockResolvedValue({
        tankId,
        tenantId,
        currentBiomassKg: 1500, // 15 kg/m3 density
        isDeleted: false,
      });

      const result = await service.analyzeTankDensity(tankId, tenantId);

      expect(result.status).toBe('optimal');
      expect(result.currentDensityKgM3).toBe(15);
      expect(result.utilizationPercent).toBe(60); // 15/25 * 100
      expect(result.recommendation).toBeUndefined();
    });

    it('should return high status when density above optimal', async () => {
      mockTankRepository.findOne.mockResolvedValue({
        id: tankId,
        tenantId,
        tankCode: 'T-001',
        volumeM3: 100,
        maxDensityKgM3: 25,
        optimalDensityMinKgM3: 10,
        optimalDensityMaxKgM3: 20,
        isDeleted: false,
      });

      mockTankBatchRepository.findOne.mockResolvedValue({
        tankId,
        tenantId,
        currentBiomassKg: 2200, // 22 kg/m3 density (above optimal)
        isDeleted: false,
      });

      const result = await service.analyzeTankDensity(tankId, tenantId);

      expect(result.status).toBe('high');
      expect(result.currentDensityKgM3).toBe(22);
      expect(result.recommendation).toContain('transfer');
    });

    it('should return critical status when density at or above max', async () => {
      mockTankRepository.findOne.mockResolvedValue({
        id: tankId,
        tenantId,
        tankCode: 'T-001',
        volumeM3: 100,
        maxDensityKgM3: 25,
        optimalDensityMinKgM3: 10,
        optimalDensityMaxKgM3: 20,
        isDeleted: false,
      });

      mockTankBatchRepository.findOne.mockResolvedValue({
        tankId,
        tenantId,
        currentBiomassKg: 2600, // 26 kg/m3 density (critical)
        isDeleted: false,
      });

      const result = await service.analyzeTankDensity(tankId, tenantId);

      expect(result.status).toBe('critical');
      expect(result.recommendation).toContain('ACİL');
    });

    it('should return low status when density below optimal', async () => {
      mockTankRepository.findOne.mockResolvedValue({
        id: tankId,
        tenantId,
        tankCode: 'T-001',
        volumeM3: 100,
        maxDensityKgM3: 25,
        optimalDensityMinKgM3: 10,
        optimalDensityMaxKgM3: 20,
        isDeleted: false,
      });

      mockTankBatchRepository.findOne.mockResolvedValue({
        tankId,
        tenantId,
        currentBiomassKg: 500, // 5 kg/m3 density (low)
        isDeleted: false,
      });

      const result = await service.analyzeTankDensity(tankId, tenantId);

      expect(result.status).toBe('low');
      expect(result.recommendation).toContain('transfer edilebilir');
    });

    it('should handle empty tank', async () => {
      mockTankRepository.findOne.mockResolvedValue({
        id: tankId,
        tenantId,
        tankCode: 'T-001',
        volumeM3: 100,
        maxDensityKgM3: 25,
        optimalDensityMinKgM3: 10,
        optimalDensityMaxKgM3: 20,
        isDeleted: false,
      });

      mockTankBatchRepository.findOne.mockResolvedValue(null);

      const result = await service.analyzeTankDensity(tankId, tenantId);

      expect(result.currentBiomassKg).toBe(0);
      expect(result.currentDensityKgM3).toBe(0);
      expect(result.status).toBe('optimal'); // Empty tank is technically optimal
    });
  });

  describe('calculatePostTransferDensity', () => {
    it('should calculate post-transfer densities correctly', () => {
      const sourceTank = { volumeM3: 100, currentBiomassKg: 2000 };
      const destinationTank = { volumeM3: 100, currentBiomassKg: 500 };
      const transferBiomassKg = 500;

      const result = service.calculatePostTransferDensity(
        sourceTank,
        destinationTank,
        transferBiomassKg,
      );

      expect(result.sourceDensity).toBe(15); // (2000-500)/100
      expect(result.destinationDensity).toBe(10); // (500+500)/100
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should warn when transfer exceeds source biomass', () => {
      const sourceTank = { volumeM3: 100, currentBiomassKg: 500 };
      const destinationTank = { volumeM3: 100, currentBiomassKg: 500 };
      const transferBiomassKg = 600;

      const result = service.calculatePostTransferDensity(
        sourceTank,
        destinationTank,
        transferBiomassKg,
      );

      expect(result.isValid).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('kaynak tank');
    });

    it('should warn when destination density becomes critical', () => {
      const sourceTank = { volumeM3: 100, currentBiomassKg: 3000 };
      const destinationTank = { volumeM3: 100, currentBiomassKg: 2000 };
      const transferBiomassKg = 1000;

      const result = service.calculatePostTransferDensity(
        sourceTank,
        destinationTank,
        transferBiomassKg,
      );

      // Destination will have 30 kg/m3 (2000+1000)/100
      expect(result.destinationDensity).toBe(30);
      expect(result.isValid).toBe(false);
      expect(result.warnings.some(w => w.includes('kritik'))).toBe(true);
    });

    it('should handle different tank volumes', () => {
      const sourceTank = { volumeM3: 200, currentBiomassKg: 4000 }; // 20 kg/m3
      const destinationTank = { volumeM3: 50, currentBiomassKg: 250 }; // 5 kg/m3
      const transferBiomassKg = 500;

      const result = service.calculatePostTransferDensity(
        sourceTank,
        destinationTank,
        transferBiomassKg,
      );

      expect(result.sourceDensity).toBe(17.5); // 3500/200
      expect(result.destinationDensity).toBe(15); // 750/50
      expect(result.isValid).toBe(true);
    });
  });

  describe('projectBiomass', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should project biomass growth correctly', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: {
          growthParameters: {
            avgDailyGrowth: 2,
            expectedSurvivalRate: 95,
          },
        },
        fcr: { target: 1.5 },
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue(null);

      const result = await service.projectBiomass(batchId, tenantId, 30);

      expect(result.currentBiomassKg).toBe(2000); // 10000 * 200 / 1000
      expect(result.projectedBiomassKg).toBeGreaterThan(result.currentBiomassKg);
      expect(result.daysForward).toBe(30);
      expect(result.dailyGrowthKg).toBeGreaterThan(0);
      expect(result.assumptions.survivalRate).toBe(95);
      expect(result.assumptions.dailyGrowthG).toBe(2);
      expect(result.assumptions.fcr).toBe(1.5);
    });

    it('should throw error when batch not found', async () => {
      mockBatchRepository.findOne.mockResolvedValue(null);

      await expect(service.projectBiomass(batchId, tenantId, 30))
        .rejects.toThrow(`Batch ${batchId} bulunamadı`);
    });

    it('should use default values when species data missing', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: null,
        fcr: null,
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue(null);

      const result = await service.projectBiomass(batchId, tenantId, 30);

      expect(result.assumptions.survivalRate).toBe(95); // default
      expect(result.assumptions.dailyGrowthG).toBe(1); // default
      expect(result.assumptions.fcr).toBe(1.5); // default
    });

    it('should account for mortality in projection', async () => {
      mockBatchRepository.findOne.mockResolvedValue({
        id: batchId,
        tenantId,
        currentQuantity: 10000,
        species: {
          growthParameters: {
            avgDailyGrowth: 2,
            expectedSurvivalRate: 90, // 10% annual mortality
          },
        },
        fcr: { target: 1.5 },
        getCurrentAvgWeight: () => 200,
      });

      mockMeasurementRepository.findOne.mockResolvedValue(null);

      const result = await service.projectBiomass(batchId, tenantId, 30);

      // With 90% survival rate, daily mortality = 10%/365 ≈ 0.027%/day
      // Over 30 days, quantity should decrease slightly
      // But biomass should still increase due to growth
      expect(result.projectedBiomassKg).toBeGreaterThan(result.currentBiomassKg);
    });
  });

  describe('getSiteBiomassReport', () => {
    const tenantId = 'tenant-123';
    const siteId = 'site-789';

    it('should aggregate biomass across all batches', async () => {
      mockBatchRepository.find.mockResolvedValue([
        {
          id: 'batch-1',
          tenantId,
          siteId,
          speciesId: 'species-1',
          species: { commonName: 'Salmon' },
          currentQuantity: 5000,
          getCurrentAvgWeight: () => 200,
        },
        {
          id: 'batch-2',
          tenantId,
          siteId,
          speciesId: 'species-1',
          species: { commonName: 'Salmon' },
          currentQuantity: 3000,
          getCurrentAvgWeight: () => 300,
        },
      ]);

      mockMeasurementRepository.findOne.mockResolvedValue(null);
      mockTankBatchRepository.count.mockResolvedValue(5);

      const result = await service.getSiteBiomassReport(siteId, tenantId);

      expect(result.siteId).toBe(siteId);
      expect(result.batchCount).toBe(2);
      expect(result.totalQuantity).toBe(8000);
      expect(result.totalBiomassKg).toBe(1900); // (5000*200 + 3000*300)/1000
      expect(result.tankCount).toBe(5);
    });

    it('should break down biomass by species', async () => {
      mockBatchRepository.find.mockResolvedValue([
        {
          id: 'batch-1',
          tenantId,
          siteId,
          speciesId: 'species-1',
          species: { commonName: 'Salmon' },
          currentQuantity: 5000,
          getCurrentAvgWeight: () => 200,
        },
        {
          id: 'batch-2',
          tenantId,
          siteId,
          speciesId: 'species-2',
          species: { commonName: 'Trout' },
          currentQuantity: 3000,
          getCurrentAvgWeight: () => 300,
        },
      ]);

      mockMeasurementRepository.findOne.mockResolvedValue(null);
      mockTankBatchRepository.count.mockResolvedValue(5);

      const result = await service.getSiteBiomassReport(siteId, tenantId);

      expect(result.speciesBreakdown).toHaveLength(2);

      const salmonBreakdown = result.speciesBreakdown.find(s => s.speciesName === 'Salmon');
      const troutBreakdown = result.speciesBreakdown.find(s => s.speciesName === 'Trout');

      expect(salmonBreakdown).toBeDefined();
      expect(troutBreakdown).toBeDefined();
      expect(salmonBreakdown!.biomassKg).toBe(1000); // 5000*200/1000
      expect(troutBreakdown!.biomassKg).toBe(900); // 3000*300/1000
    });

    it('should handle empty site', async () => {
      mockBatchRepository.find.mockResolvedValue([]);
      mockTankBatchRepository.count.mockResolvedValue(0);

      const result = await service.getSiteBiomassReport(siteId, tenantId);

      expect(result.totalBiomassKg).toBe(0);
      expect(result.totalQuantity).toBe(0);
      expect(result.batchCount).toBe(0);
      expect(result.speciesBreakdown).toHaveLength(0);
    });
  });
});
