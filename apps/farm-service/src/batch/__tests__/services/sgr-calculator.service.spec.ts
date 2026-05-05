/**
 * SGR Calculator Service Unit Tests
 *
 * Verifies the current public API: direct SGR calculation, trend analysis,
 * and cross-batch comparison. Removed legacy facade methods are not asserted.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SGRCalculatorService } from '../../services/sgr-calculator.service';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';
import { Batch } from '../../entities/batch.entity';
import { Species } from '../../../species/entities/species.entity';

describe('SGRCalculatorService', () => {
  let service: SGRCalculatorService;
  let measurementRepository: jest.Mocked<Repository<GrowthMeasurement>>;
  let batchRepository: jest.Mocked<Repository<Batch>>;
  let speciesRepository: jest.Mocked<Repository<Species>>;

  const mockMeasurementRepository = {
    find: jest.fn(),
  };
  const mockBatchRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const mockSpeciesRepository = {
    findOne: jest.fn(),
  };

  const tenantId = 'tenant-123';
  const batchId = 'batch-456';

  const createBatch = (id = batchId): Batch => ({
    id,
    tenantId,
    batchNumber: `B-${id}`,
    speciesId: 'species-1',
    species: {
      id: 'species-1',
      scientificName: 'rainbow trout',
      commonName: 'Rainbow Trout',
    } as Species,
    getCurrentAvgWeight: jest.fn().mockReturnValue(120),
  } as unknown as Batch);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SGRCalculatorService,
        {
          provide: getRepositoryToken(GrowthMeasurement),
          useValue: mockMeasurementRepository,
        },
        {
          provide: getRepositoryToken(Batch),
          useValue: mockBatchRepository,
        },
        {
          provide: getRepositoryToken(Species),
          useValue: mockSpeciesRepository,
        },
      ],
    }).compile();

    service = module.get<SGRCalculatorService>(SGRCalculatorService);
    measurementRepository = module.get(getRepositoryToken(GrowthMeasurement));
    batchRepository = module.get(getRepositoryToken(Batch));
    speciesRepository = module.get(getRepositoryToken(Species));

    jest.clearAllMocks();
  });

  describe('calculateSGR', () => {
    it('calculates valid SGR for normal growth', () => {
      const result = service.calculateSGR(100, 150, 14);

      expect(result.sgr).toBeCloseTo(2.89, 1);
      expect(result.initialWeightG).toBe(100);
      expect(result.finalWeightG).toBe(150);
      expect(result.days).toBe(14);
      expect(result.isValid).toBe(true);
    });

    it('returns invalid result for non-positive inputs', () => {
      expect(service.calculateSGR(0, 100, 14)).toEqual(
        expect.objectContaining({ sgr: 0, isValid: false }),
      );
      expect(service.calculateSGR(100, 0, 14)).toEqual(
        expect.objectContaining({ sgr: 0, isValid: false }),
      );
      expect(service.calculateSGR(100, 150, 0)).toEqual(
        expect.objectContaining({ sgr: 0, isValid: false }),
      );
    });

    it('flags weight loss as invalid negative SGR', () => {
      const result = service.calculateSGR(150, 100, 14);

      expect(result.sgr).toBeCloseTo(-2.89, 1);
      expect(result.isValid).toBe(false);
      expect(result.warning).toContain('Negatif SGR');
    });
  });

  describe('analyzeSGRTrend', () => {
    it('returns stable empty trend when less than two measurements exist', async () => {
      batchRepository.findOne.mockResolvedValue(createBatch());
      measurementRepository.find.mockResolvedValue([]);

      const result = await service.analyzeSGRTrend(batchId, tenantId);

      expect(result).toEqual({
        currentSGR: 0,
        avgSGR: 0,
        minSGR: 0,
        maxSGR: 0,
        trend: 'stable',
        comparedToTarget: 0,
        historicalSGR: [],
      });
    });

    it('calculates historical SGR values and detects improving trend', async () => {
      batchRepository.findOne.mockResolvedValue(createBatch());
      measurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 110, measurementDate: new Date('2024-01-08') },
        { id: '3', averageWeight: 130, measurementDate: new Date('2024-01-15') },
        { id: '4', averageWeight: 165, measurementDate: new Date('2024-01-22') },
        { id: '5', averageWeight: 220, measurementDate: new Date('2024-01-29') },
      ] as GrowthMeasurement[]);

      const result = await service.analyzeSGRTrend(batchId, tenantId);

      expect(result.currentSGR).toBeGreaterThan(0);
      expect(result.avgSGR).toBeGreaterThan(0);
      expect(result.historicalSGR).toHaveLength(4);
      expect(result.trend).toBe('improving');
      expect(result.targetSGR).toBeGreaterThan(0);
    });

    it('throws when batch is not found for tenant', async () => {
      batchRepository.findOne.mockResolvedValue(null);

      await expect(service.analyzeSGRTrend(batchId, tenantId)).rejects.toThrow(
        `Batch ${batchId} bulunamadı`,
      );
    });
  });

  describe('compareBatchSGR', () => {
    it('compares batches and sorts by current SGR descending', async () => {
      const batchA = createBatch('batch-a');
      const batchB = createBatch('batch-b');
      batchRepository.find.mockResolvedValue([batchA, batchB]);
      batchRepository.findOne
        .mockResolvedValueOnce(batchA)
        .mockResolvedValueOnce(batchB);
      measurementRepository.find
        .mockResolvedValueOnce([
          { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
          { id: '2', averageWeight: 120, measurementDate: new Date('2024-01-08') },
        ] as GrowthMeasurement[])
        .mockResolvedValueOnce([
          { id: '3', averageWeight: 100, measurementDate: new Date('2024-01-01') },
          { id: '4', averageWeight: 110, measurementDate: new Date('2024-01-08') },
        ] as GrowthMeasurement[]);

      const result = await service.compareBatchSGR(['batch-a', 'batch-b'], tenantId);

      expect(result).toHaveLength(2);
      expect(result[0]!.currentSGR).toBeGreaterThanOrEqual(result[1]!.currentSGR);
      expect(result[0]).toEqual(
        expect.objectContaining({
          batchId: 'batch-a',
          batchNumber: 'B-batch-a',
        }),
      );
    });

    it('skips missing batches from comparison output', async () => {
      batchRepository.find.mockResolvedValue([createBatch('batch-a')]);
      batchRepository.findOne.mockResolvedValue(createBatch('batch-a'));
      measurementRepository.find.mockResolvedValue([
        { id: '1', averageWeight: 100, measurementDate: new Date('2024-01-01') },
        { id: '2', averageWeight: 120, measurementDate: new Date('2024-01-08') },
      ] as GrowthMeasurement[]);

      const result = await service.compareBatchSGR(['batch-a', 'missing'], tenantId);

      expect(result.map((item) => item.batchId)).toEqual(['batch-a']);
      expect(speciesRepository.findOne).not.toHaveBeenCalled();
    });
  });
});
