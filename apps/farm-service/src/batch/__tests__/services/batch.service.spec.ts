/**
 * BatchService unit tests — READ paths only.
 *
 * The write shadow this class used to carry (createBatch, allocateBatchToTank,
 * transferBatch, recordOperation and their private helpers) was deleted by
 * FARM-HIGH-109 / FARM-LOW-211 because it had no production caller. The tests
 * for it went with the code they tested; nothing that still exists lost
 * coverage.
 *
 * The stock-removal guard those tests also touched is NOT unguarded now: the
 * same MortalityCullPolicy discipline is asserted on the real CQRS entry
 * points — record-mortality, record-cull and record-cleaner-mortality — by
 * `tests/invariants/farm-stock-mutation-ssot.spec.ts` (FARM-CRITICAL-050).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TankAllocation, AllocationType } from '../../entities/tank-allocation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../entities/tank-operation.entity';
import { BatchService } from '../../services/batch.service';

describe('BatchService', () => {
  let service: BatchService;
  let allocationRepository: jest.Mocked<Repository<TankAllocation>>;
  let tankBatchRepository: jest.Mocked<Repository<TankBatch>>;
  let operationRepository: jest.Mocked<Repository<TankOperation>>;

  const createMockTankBatch = (overrides: Partial<TankBatch> = {}): TankBatch =>
    ({
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
    }) as TankBatch;

  const createMockAllocation = (overrides: Partial<TankAllocation> = {}): TankAllocation =>
    ({
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
    }) as TankAllocation;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchService,
        { provide: getRepositoryToken(TankAllocation), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(TankBatch), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(TankOperation), useValue: { find: jest.fn() } },
      ],
    }).compile();

    service = module.get<BatchService>(BatchService);
    allocationRepository = module.get(getRepositoryToken(TankAllocation));
    tankBatchRepository = module.get(getRepositoryToken(TankBatch));
    operationRepository = module.get(getRepositoryToken(TankOperation));
  });

  afterEach(() => {
    jest.clearAllMocks();
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
});
