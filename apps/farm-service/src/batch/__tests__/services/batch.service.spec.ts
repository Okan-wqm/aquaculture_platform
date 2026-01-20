/**
 * BatchService Unit Tests
 *
 * Comprehensive tests for batch management, tank allocation,
 * operations, and metric calculations.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { BatchService, CreateBatchInput, AllocateBatchInput, RecordOperationInput } from '../../services/batch.service';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankAllocation, AllocationType } from '../../entities/tank-allocation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../entities/tank-operation.entity';
import { Tank } from '../../../tank/entities/tank.entity';

describe('BatchService', () => {
  let service: BatchService;
  let batchRepository: jest.Mocked<Repository<Batch>>;
  let allocationRepository: jest.Mocked<Repository<TankAllocation>>;
  let tankBatchRepository: jest.Mocked<Repository<TankBatch>>;
  let operationRepository: jest.Mocked<Repository<TankOperation>>;
  let tankRepository: jest.Mocked<Repository<Tank>>;

  // Test data factories
  const createMockBatch = (overrides: Partial<Batch> = {}): Batch => ({
    id: 'batch-123',
    tenantId: 'tenant-1',
    batchNumber: 'B-2024-001',
    speciesId: 'species-1',
    inputType: 'smolt',
    initialQuantity: 10000,
    currentQuantity: 9500,
    totalMortality: 500,
    cullCount: 0,
    totalFeedConsumed: 5000,
    totalFeedCost: 25000,
    stockedAt: new Date('2024-01-01'),
    status: BatchStatus.ACTIVE,
    isActive: true,
    weight: {
      initial: { avgWeight: 50, totalBiomass: 500, measuredAt: new Date() },
      theoretical: { avgWeight: 150, totalBiomass: 1425, lastCalculatedAt: new Date(), basedOnFCR: 1.2 },
      actual: { avgWeight: 145, totalBiomass: 1377.5, lastMeasuredAt: new Date(), sampleSize: 100, confidencePercent: 95 },
      variance: { weightDifference: -5, percentageDifference: -3.33, isSignificant: false },
    },
    fcr: { target: 1.2, actual: 1.15, theoretical: 1.2, isUserOverride: false, lastUpdatedAt: new Date() },
    feedingSummary: { totalFeedGiven: 5000, totalFeedCost: 25000 },
    growthMetrics: {
      growthRate: { actual: 2.5, target: 2.8, variancePercent: -10.7 },
      daysInProduction: 90,
      projections: { confidenceLevel: 'medium' },
    },
    mortalitySummary: { totalMortality: 500, mortalityRate: 5 },
    getMortalityRate: jest.fn().mockReturnValue(5),
    getRetentionRate: jest.fn().mockReturnValue(95),
    calculateFCR: jest.fn().mockReturnValue(1.15),
    calculateSGR: jest.fn().mockReturnValue(2.5),
    getDaysInProduction: jest.fn().mockReturnValue(90),
    getCurrentBiomass: jest.fn().mockReturnValue(1377.5),
    ...overrides,
  } as unknown as Batch);

  const createMockTank = (overrides: Partial<Tank> = {}): Tank => ({
    id: 'tank-1',
    tenantId: 'tenant-1',
    name: 'Tank A1',
    volume: 500,
    waterVolume: 450,
    maxDensity: 25,
    status: 'active',
    ...overrides,
  } as Tank);

  const createMockTankBatch = (overrides: Partial<TankBatch> = {}): TankBatch => ({
    id: 'tank-batch-1',
    tenantId: 'tenant-1',
    tankId: 'tank-1',
    primaryBatchId: 'batch-123',
    totalQuantity: 5000,
    totalBiomassKg: 725,
    avgWeightG: 145,
    densityKgM3: 1.61,
    isMixedBatch: false,
    isOverCapacity: false,
    capacityUsedPercent: 6.44,
    ...overrides,
  } as TankBatch);

  const createMockAllocation = (overrides: Partial<TankAllocation> = {}): TankAllocation => ({
    id: 'alloc-1',
    tenantId: 'tenant-1',
    batchId: 'batch-123',
    tankId: 'tank-1',
    allocationType: AllocationType.INITIAL_STOCKING,
    allocationDate: new Date(),
    quantity: 5000,
    avgWeightG: 50,
    biomassKg: 250,
    densityKgM3: 0.56,
    allocatedBy: 'user-1',
    isDeleted: false,
    ...overrides,
  } as TankAllocation);

  beforeEach(async () => {
    const mockBatchRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn(),
      })),
    };

    const mockAllocationRepository = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
    };

    const mockTankBatchRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };

    const mockOperationRepository = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
    };

    const mockTankRepository = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchService,
        { provide: getRepositoryToken(Batch), useValue: mockBatchRepository },
        { provide: getRepositoryToken(TankAllocation), useValue: mockAllocationRepository },
        { provide: getRepositoryToken(TankBatch), useValue: mockTankBatchRepository },
        { provide: getRepositoryToken(TankOperation), useValue: mockOperationRepository },
        { provide: getRepositoryToken(Tank), useValue: mockTankRepository },
      ],
    }).compile();

    service = module.get<BatchService>(BatchService);
    batchRepository = module.get(getRepositoryToken(Batch));
    allocationRepository = module.get(getRepositoryToken(TankAllocation));
    tankBatchRepository = module.get(getRepositoryToken(TankBatch));
    operationRepository = module.get(getRepositoryToken(TankOperation));
    tankRepository = module.get(getRepositoryToken(Tank));
  });

  describe('Batch CRUD Operations', () => {
    describe('createBatch', () => {
      it('should create a new batch with correct initial values', async () => {
        const input: CreateBatchInput = {
          tenantId: 'tenant-1',
          batchNumber: 'B-2024-001',
          speciesId: 'species-1',
          inputType: 'smolt',
          initialQuantity: 10000,
          initialAvgWeightG: 50,
          stockedAt: new Date('2024-01-01'),
          supplierId: 'supplier-1',
          purchaseCost: 50000,
          currency: 'TRY',
          notes: 'Test batch',
          createdBy: 'user-1',
        };

        const expectedBatch = createMockBatch({ batchNumber: input.batchNumber });
        batchRepository.create.mockReturnValue(expectedBatch);
        batchRepository.save.mockResolvedValue(expectedBatch);

        const result = await service.createBatch(input);

        expect(batchRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: input.tenantId,
            batchNumber: input.batchNumber,
            initialQuantity: input.initialQuantity,
            currentQuantity: input.initialQuantity,
            totalMortality: 0,
            cullCount: 0,
            status: BatchStatus.QUARANTINE,
          }),
        );
        expect(result).toEqual(expectedBatch);
      });

      it('should calculate initial biomass correctly', async () => {
        const input: CreateBatchInput = {
          tenantId: 'tenant-1',
          batchNumber: 'B-2024-002',
          speciesId: 'species-1',
          inputType: 'smolt',
          initialQuantity: 10000,
          initialAvgWeightG: 50,
          stockedAt: new Date(),
          createdBy: 'user-1',
        };

        const expectedBiomass = (10000 * 50) / 1000; // 500 kg
        batchRepository.create.mockImplementation((data) => data as Batch);
        batchRepository.save.mockImplementation((batch: unknown) => Promise.resolve(batch as Batch));

        await service.createBatch(input);

        expect(batchRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            weight: expect.objectContaining({
              initial: expect.objectContaining({
                avgWeight: 50,
                totalBiomass: expectedBiomass,
              }),
            }),
          }),
        );
      });

      it('should default currency to TRY when not provided', async () => {
        const input: CreateBatchInput = {
          tenantId: 'tenant-1',
          batchNumber: 'B-2024-003',
          speciesId: 'species-1',
          inputType: 'smolt',
          initialQuantity: 1000,
          initialAvgWeightG: 25,
          stockedAt: new Date(),
          createdBy: 'user-1',
        };

        batchRepository.create.mockImplementation((data) => data as Batch);
        batchRepository.save.mockImplementation((batch: unknown) => Promise.resolve(batch as Batch));

        await service.createBatch(input);

        expect(batchRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ currency: 'TRY' }),
        );
      });
    });

    describe('findBatchById', () => {
      it('should return batch when found', async () => {
        const mockBatch = createMockBatch();
        batchRepository.findOne.mockResolvedValue(mockBatch);

        const result = await service.findBatchById('batch-123', 'tenant-1');

        expect(result).toEqual(mockBatch);
        expect(batchRepository.findOne).toHaveBeenCalledWith({
          where: { id: 'batch-123', tenantId: 'tenant-1', isActive: true },
          relations: ['species'],
        });
      });

      it('should throw NotFoundException when batch not found', async () => {
        batchRepository.findOne.mockResolvedValue(null);

        await expect(service.findBatchById('non-existent', 'tenant-1'))
          .rejects
          .toThrow(NotFoundException);
      });

      it('should not return inactive batches', async () => {
        batchRepository.findOne.mockResolvedValue(null);

        await expect(service.findBatchById('inactive-batch', 'tenant-1'))
          .rejects
          .toThrow(NotFoundException);
      });
    });

    describe('updateBatch', () => {
      it('should update batch with provided fields', async () => {
        const mockBatch = createMockBatch();
        batchRepository.findOne.mockResolvedValue(mockBatch);
        batchRepository.save.mockImplementation((batch: unknown) => Promise.resolve(batch as Batch));

        const updates = { notes: 'Updated notes', status: BatchStatus.ACTIVE };
        const result = await service.updateBatch('batch-123', 'tenant-1', updates);

        expect(result.notes).toBe('Updated notes');
        expect(batchRepository.save).toHaveBeenCalled();
      });
    });

    describe('deleteBatch', () => {
      it('should soft delete batch', async () => {
        const mockBatch = createMockBatch();
        batchRepository.findOne.mockResolvedValue(mockBatch);
        batchRepository.save.mockImplementation((batch: unknown) => Promise.resolve(batch as Batch));

        await service.deleteBatch('batch-123', 'tenant-1', 'user-1');

        expect(batchRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            isActive: false,
            status: BatchStatus.CLOSED,
            updatedBy: 'user-1',
          }),
        );
      });
    });

    describe('findAllBatches', () => {
      it('should return all batches for tenant', async () => {
        const mockBatches = [createMockBatch(), createMockBatch({ id: 'batch-456' })];
        const queryBuilder = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(mockBatches),
        };
        batchRepository.createQueryBuilder.mockReturnValue(queryBuilder as any);

        const result = await service.findAllBatches('tenant-1');

        expect(result).toEqual(mockBatches);
        expect(queryBuilder.where).toHaveBeenCalledWith(
          'batch.tenantId = :tenantId',
          { tenantId: 'tenant-1' },
        );
      });

      it('should filter by status when provided', async () => {
        const queryBuilder = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        };
        batchRepository.createQueryBuilder.mockReturnValue(queryBuilder as any);

        await service.findAllBatches('tenant-1', { status: [BatchStatus.ACTIVE, BatchStatus.HARVESTED] });

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          'batch.status IN (:...statuses)',
          { statuses: [BatchStatus.ACTIVE, BatchStatus.HARVESTED] },
        );
      });

      it('should filter by species when provided', async () => {
        const queryBuilder = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        };
        batchRepository.createQueryBuilder.mockReturnValue(queryBuilder as any);

        await service.findAllBatches('tenant-1', { speciesId: 'salmon-atlantic' });

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          'batch.speciesId = :speciesId',
          { speciesId: 'salmon-atlantic' },
        );
      });
    });
  });

  describe('Tank Allocation', () => {
    describe('allocateBatchToTank', () => {
      it('should allocate batch to tank successfully', async () => {
        const mockBatch = createMockBatch({ status: BatchStatus.QUARANTINE });
        const mockTank = createMockTank();
        const mockAllocation = createMockAllocation();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        allocationRepository.create.mockReturnValue(mockAllocation);
        allocationRepository.save.mockResolvedValue(mockAllocation);
        allocationRepository.find.mockResolvedValue([mockAllocation]);
        tankBatchRepository.findOne.mockResolvedValue(null);
        tankBatchRepository.create.mockReturnValue(createMockTankBatch());
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));

        const input: AllocateBatchInput = {
          batchId: 'batch-123',
          tankId: 'tank-1',
          quantity: 5000,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
          allocatedBy: 'user-1',
        };

        const result = await service.allocateBatchToTank(input);

        expect(result).toEqual(mockAllocation);
        expect(allocationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            batchId: input.batchId,
            tankId: input.tankId,
            quantity: input.quantity,
          }),
        );
      });

      it('should throw NotFoundException if batch not found', async () => {
        batchRepository.findOne.mockResolvedValue(null);

        const input: AllocateBatchInput = {
          batchId: 'non-existent',
          tankId: 'tank-1',
          quantity: 5000,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
          allocatedBy: 'user-1',
        };

        await expect(service.allocateBatchToTank(input))
          .rejects
          .toThrow(NotFoundException);
      });

      it('should throw NotFoundException if tank not found', async () => {
        const mockBatch = createMockBatch();
        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(null);

        const input: AllocateBatchInput = {
          batchId: 'batch-123',
          tankId: 'non-existent',
          quantity: 5000,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
          allocatedBy: 'user-1',
        };

        await expect(service.allocateBatchToTank(input))
          .rejects
          .toThrow(NotFoundException);
      });

      it('should calculate density correctly', async () => {
        const mockBatch = createMockBatch({ status: BatchStatus.QUARANTINE });
        const mockTank = createMockTank({ waterVolume: 500 });

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        allocationRepository.create.mockImplementation((data) => data as TankAllocation);
        allocationRepository.save.mockImplementation((a: unknown) => Promise.resolve(a as TankAllocation));
        allocationRepository.find.mockResolvedValue([]);
        tankBatchRepository.findOne.mockResolvedValue(null);
        tankBatchRepository.create.mockReturnValue(createMockTankBatch());
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));

        const input: AllocateBatchInput = {
          batchId: 'batch-123',
          tankId: 'tank-1',
          quantity: 5000,
          avgWeightG: 100, // 5000 * 100g = 500kg
          allocationType: AllocationType.INITIAL_STOCKING,
          allocatedBy: 'user-1',
        };

        await service.allocateBatchToTank(input);

        // Density = 500kg / 500m³ = 1 kg/m³
        expect(allocationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            biomassKg: 500,
            densityKgM3: 1,
          }),
        );
      });

      it('should change batch status from QUARANTINE to ACTIVE', async () => {
        const mockBatch = createMockBatch({ status: BatchStatus.QUARANTINE });
        const mockTank = createMockTank();
        const mockAllocation = createMockAllocation();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        allocationRepository.create.mockReturnValue(mockAllocation);
        allocationRepository.save.mockResolvedValue(mockAllocation);
        allocationRepository.find.mockResolvedValue([mockAllocation]);
        tankBatchRepository.findOne.mockResolvedValue(null);
        tankBatchRepository.create.mockReturnValue(createMockTankBatch());
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));

        const input: AllocateBatchInput = {
          batchId: 'batch-123',
          tankId: 'tank-1',
          quantity: 5000,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
          allocatedBy: 'user-1',
        };

        await service.allocateBatchToTank(input);

        expect(batchRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            status: BatchStatus.ACTIVE,
          }),
        );
      });
    });
  });

  describe('Tank Operations', () => {
    describe('recordOperation - Mortality', () => {
      it('should record mortality and update batch metrics', async () => {
        const mockBatch = createMockBatch();
        const mockTank = createMockTank();
        const mockTankBatch = createMockTankBatch();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        tankBatchRepository.findOne.mockResolvedValue(mockTankBatch);
        operationRepository.create.mockImplementation((data) => data as TankOperation);
        operationRepository.save.mockImplementation((op: unknown) => Promise.resolve(op as TankOperation));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));
        allocationRepository.find.mockResolvedValue([]);
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));

        const input: RecordOperationInput = {
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          batchId: 'batch-123',
          operationType: OperationType.MORTALITY,
          operationDate: new Date(),
          quantity: 50,
          avgWeightG: 150,
          reason: 'disease',
          detail: 'Bacterial infection',
          performedBy: 'user-1',
        };

        await service.recordOperation(input);

        expect(operationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            operationType: OperationType.MORTALITY,
            quantity: 50,
            mortalityReason: 'disease',
            mortalityDetail: 'Bacterial infection',
          }),
        );
      });

      it('should update batch currentQuantity after mortality', async () => {
        const mockBatch = createMockBatch({ currentQuantity: 9500, totalMortality: 500 });
        const mockTank = createMockTank();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        tankBatchRepository.findOne.mockResolvedValue(createMockTankBatch());
        operationRepository.create.mockImplementation((data) => data as TankOperation);
        operationRepository.save.mockImplementation((op: unknown) => Promise.resolve(op as TankOperation));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));
        allocationRepository.find.mockResolvedValue([]);
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));

        const input: RecordOperationInput = {
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          batchId: 'batch-123',
          operationType: OperationType.MORTALITY,
          operationDate: new Date(),
          quantity: 100,
          performedBy: 'user-1',
        };

        await service.recordOperation(input);

        expect(batchRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            currentQuantity: 9400, // 9500 - 100
            totalMortality: 600, // 500 + 100
          }),
        );
      });
    });

    describe('recordOperation - Harvest', () => {
      it('should close batch when fully harvested', async () => {
        const mockBatch = createMockBatch({ currentQuantity: 100, harvestedQuantity: 0 });
        const mockTank = createMockTank();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        tankBatchRepository.findOne.mockResolvedValue(createMockTankBatch());
        operationRepository.create.mockImplementation((data) => data as TankOperation);
        operationRepository.save.mockImplementation((op: unknown) => Promise.resolve(op as TankOperation));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));
        allocationRepository.find.mockResolvedValue([]);
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));

        const input: RecordOperationInput = {
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          batchId: 'batch-123',
          operationType: OperationType.HARVEST,
          operationDate: new Date(),
          quantity: 100,
          avgWeightG: 5000,
          performedBy: 'user-1',
        };

        await service.recordOperation(input);

        expect(batchRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            status: BatchStatus.HARVESTED,
            currentQuantity: 0,
          }),
        );
      });

      it('should update harvestedQuantity after partial harvest', async () => {
        const mockBatch = createMockBatch({ currentQuantity: 5000, harvestedQuantity: 1000 });
        const mockTank = createMockTank();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        tankBatchRepository.findOne.mockResolvedValue(createMockTankBatch());
        operationRepository.create.mockImplementation((data) => data as TankOperation);
        operationRepository.save.mockImplementation((op: unknown) => Promise.resolve(op as TankOperation));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));
        allocationRepository.find.mockResolvedValue([]);
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));

        const input: RecordOperationInput = {
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          batchId: 'batch-123',
          operationType: OperationType.HARVEST,
          operationDate: new Date(),
          quantity: 2000,
          avgWeightG: 5000,
          performedBy: 'user-1',
        };

        await service.recordOperation(input);

        expect(batchRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            harvestedQuantity: 3000, // 1000 + 2000
            currentQuantity: 3000, // 5000 - 2000
          }),
        );
      });
    });

    describe('recordOperation - Transfer', () => {
      it('should record transfer out with destination tank', async () => {
        const mockBatch = createMockBatch();
        const mockTank = createMockTank();

        batchRepository.findOne.mockResolvedValue(mockBatch);
        tankRepository.findOne.mockResolvedValue(mockTank);
        tankBatchRepository.findOne.mockResolvedValue(createMockTankBatch());
        operationRepository.create.mockImplementation((data) => data as TankOperation);
        operationRepository.save.mockImplementation((op: unknown) => Promise.resolve(op as TankOperation));
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));
        allocationRepository.find.mockResolvedValue([]);
        tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));

        const input: RecordOperationInput = {
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          batchId: 'batch-123',
          operationType: OperationType.TRANSFER_OUT,
          operationDate: new Date(),
          quantity: 1000,
          avgWeightG: 150,
          destinationTankId: 'tank-2',
          reason: 'Density optimization',
          performedBy: 'user-1',
        };

        await service.recordOperation(input);

        expect(operationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            operationType: OperationType.TRANSFER_OUT,
            destinationTankId: 'tank-2',
            transferReason: 'Density optimization',
          }),
        );
      });
    });
  });

  describe('Metrics Calculations', () => {
    describe('calculateFCR', () => {
      it('should calculate FCR correctly', async () => {
        const mockBatch = createMockBatch();
        mockBatch.calculateFCR = jest.fn().mockReturnValue(1.25);

        batchRepository.findOne.mockResolvedValue(mockBatch);
        operationRepository.find.mockResolvedValue([
          { biomassKg: 10 } as TankOperation,
          { biomassKg: 5 } as TankOperation,
        ]);

        const result = await service.calculateFCR('batch-123', 'tenant-1');

        expect(mockBatch.calculateFCR).toHaveBeenCalledWith(15); // 10 + 5 mortality biomass
        expect(result).toBe(1.25);
      });
    });

    describe('calculateSGR', () => {
      it('should calculate SGR from batch', async () => {
        const mockBatch = createMockBatch();
        mockBatch.calculateSGR = jest.fn().mockReturnValue(2.5);

        batchRepository.findOne.mockResolvedValue(mockBatch);

        const result = await service.calculateSGR('batch-123', 'tenant-1');

        expect(result).toBe(2.5);
      });
    });

    describe('updateBatchMetrics', () => {
      it('should update all batch metrics', async () => {
        const mockBatch = createMockBatch();
        mockBatch.calculateFCR = jest.fn().mockReturnValue(1.15);
        mockBatch.calculateSGR = jest.fn().mockReturnValue(2.5);
        mockBatch.getRetentionRate = jest.fn().mockReturnValue(95);
        mockBatch.getDaysInProduction = jest.fn().mockReturnValue(90);
        mockBatch.getCurrentBiomass = jest.fn().mockReturnValue(1500);

        batchRepository.findOne.mockResolvedValue(mockBatch);
        operationRepository.find.mockResolvedValue([]);
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));

        const result = await service.updateBatchMetrics('batch-123', 'tenant-1');

        expect(result.fcr.actual).toBe(1.15);
        expect(result.retentionRate).toBe(95);
        expect(result.growthMetrics.daysInProduction).toBe(90);
      });

      it('should calculate cost per kg', async () => {
        const mockBatch = createMockBatch({
          purchaseCost: 50000,
          totalFeedCost: 25000,
        });
        mockBatch.getCurrentBiomass = jest.fn().mockReturnValue(1500); // 1500 kg

        batchRepository.findOne.mockResolvedValue(mockBatch);
        operationRepository.find.mockResolvedValue([]);
        batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));

        const result = await service.updateBatchMetrics('batch-123', 'tenant-1');

        // Total cost = 50000 + 25000 = 75000
        // Cost per kg = 75000 / 1500 = 50
        expect(result.costPerKg).toBe(50);
      });
    });
  });

  describe('Tank Queries', () => {
    describe('getTankBatchStatus', () => {
      it('should return tank batch status', async () => {
        const mockTankBatch = createMockTankBatch();
        tankBatchRepository.findOne.mockResolvedValue(mockTankBatch);

        const result = await service.getTankBatchStatus('tank-1', 'tenant-1');

        expect(result).toEqual(mockTankBatch);
        expect(tankBatchRepository.findOne).toHaveBeenCalledWith({
          where: { tenantId: 'tenant-1', tankId: 'tank-1' },
          relations: ['primaryBatch', 'tank'],
        });
      });

      it('should return null when no batch in tank', async () => {
        tankBatchRepository.findOne.mockResolvedValue(null);

        const result = await service.getTankBatchStatus('empty-tank', 'tenant-1');

        expect(result).toBeNull();
      });
    });

    describe('getBatchAllocations', () => {
      it('should return batch allocations', async () => {
        const mockAllocations = [
          createMockAllocation({ tankId: 'tank-1' }),
          createMockAllocation({ id: 'alloc-2', tankId: 'tank-2' }),
        ];
        allocationRepository.find.mockResolvedValue(mockAllocations);

        const result = await service.getBatchAllocations('batch-123', 'tenant-1');

        expect(result).toEqual(mockAllocations);
        expect(allocationRepository.find).toHaveBeenCalledWith({
          where: { tenantId: 'tenant-1', batchId: 'batch-123', isDeleted: false },
          relations: ['tank'],
          order: { allocationDate: 'DESC' },
        });
      });
    });

    describe('getBatchOperations', () => {
      it('should return batch operations history', async () => {
        const mockOperations = [
          { id: 'op-1', operationType: OperationType.MORTALITY } as TankOperation,
          { id: 'op-2', operationType: OperationType.HARVEST } as TankOperation,
        ];
        operationRepository.find.mockResolvedValue(mockOperations);

        const result = await service.getBatchOperations('batch-123', 'tenant-1');

        expect(result).toEqual(mockOperations);
        expect(operationRepository.find).toHaveBeenCalledWith({
          where: { tenantId: 'tenant-1', batchId: 'batch-123', isDeleted: false },
          relations: ['tank'],
          order: { operationDate: 'DESC' },
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero initial quantity', async () => {
      const input: CreateBatchInput = {
        tenantId: 'tenant-1',
        batchNumber: 'B-2024-EMPTY',
        speciesId: 'species-1',
        inputType: 'smolt',
        initialQuantity: 0,
        initialAvgWeightG: 50,
        stockedAt: new Date(),
        createdBy: 'user-1',
      };

      batchRepository.create.mockImplementation((data) => data as Batch);
      batchRepository.save.mockImplementation((batch: unknown) => Promise.resolve(batch as Batch));

      await service.createBatch(input);

      expect(batchRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          initialQuantity: 0,
          currentQuantity: 0,
          weight: expect.objectContaining({
            initial: expect.objectContaining({
              totalBiomass: 0,
            }),
          }),
        }),
      );
    });

    it('should handle tank with zero volume', async () => {
      const mockBatch = createMockBatch({ status: BatchStatus.QUARANTINE });
      const mockTank = createMockTank({ waterVolume: 0, volume: 0 });

      batchRepository.findOne.mockResolvedValue(mockBatch);
      tankRepository.findOne.mockResolvedValue(mockTank);
      allocationRepository.create.mockImplementation((data) => data as TankAllocation);
      allocationRepository.save.mockImplementation((a: unknown) => Promise.resolve(a as TankAllocation));
      allocationRepository.find.mockResolvedValue([]);
      tankBatchRepository.findOne.mockResolvedValue(null);
      tankBatchRepository.create.mockReturnValue(createMockTankBatch());
      tankBatchRepository.save.mockImplementation((tb: unknown) => Promise.resolve(tb as TankBatch));
      batchRepository.save.mockImplementation((b: unknown) => Promise.resolve(b as Batch));

      const input: AllocateBatchInput = {
        batchId: 'batch-123',
        tankId: 'tank-1',
        quantity: 1000,
        avgWeightG: 50,
        allocationType: AllocationType.INITIAL_STOCKING,
        allocatedBy: 'user-1',
      };

      // Should complete successfully without crashing on zero volume edge case
      await expect(service.allocateBatchToTank(input)).resolves.toBeDefined();

      // Verify allocation was created with correct biomass calculation
      expect(allocationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          biomassKg: 50, // 1000 fish * 50g / 1000 = 50kg
          quantity: 1000,
        }),
      );
    });
  });
});
