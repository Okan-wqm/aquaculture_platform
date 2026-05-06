/**
 * Tank Operations Contract Tests
 *
 * Verifies current tank allocation/operation entity contracts. The removed v1
 * fields (`tankCode`, `volumeM3`, `AllocationType.INITIAL`,
 * `OperationType.TRANSFER`) are intentionally not reintroduced.
 */
import { AllocationType, TankAllocation } from '../../entities/tank-allocation.entity';
import { OperationType, TankOperation } from '../../entities/tank-operation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Tank, TankMaterial, TankStatus, TankType, WaterType } from '../../../tank/entities/tank.entity';

describe('Tank Operations Contract', () => {
  const tenantId = 'tenant-1';

  const createTank = (overrides: Partial<Tank> = {}): Tank =>
    Object.assign(new Tank(), {
      id: 'tank-1',
      tenantId,
      name: 'Tank 1',
      code: 'T-001',
      departmentId: 'department-1',
      tankType: TankType.CIRCULAR,
      material: TankMaterial.FIBERGLASS,
      waterType: WaterType.SALTWATER,
      depth: 2,
      diameter: 8,
      volume: 100,
      maxBiomass: 2_500,
      maxDensity: 25,
      currentBiomass: 500,
      currentCount: 5_000,
      status: TankStatus.ACTIVE,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      version: 1,
      ...overrides,
    });

  const createTankBatch = (overrides: Partial<TankBatch> = {}): TankBatch =>
    Object.assign(new TankBatch(), {
      id: 'tank-batch-1',
      tenantId,
      tankId: 'tank-1',
      tankCode: 'T-001',
      tankName: 'Tank 1',
      primaryBatchId: 'batch-1',
      primaryBatchNumber: 'B-2026-00001',
      totalQuantity: 5_000,
      currentQuantity: 5_000,
      avgWeightG: 100,
      totalBiomassKg: 500,
      currentBiomassKg: 500,
      densityKgM3: 5,
      isMixedBatch: false,
      cleanerFishQuantity: 0,
      cleanerFishBiomassKg: 0,
      isOverCapacity: false,
      capacityUsedPercent: 20,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });

  it('uses current tank capacity fields and density calculations', () => {
    const tank = createTank();
    const tankBatch = createTankBatch();

    expect(tank.code).toBe('T-001');
    expect(tank.volume).toBe(100);
    expect(tank.maxDensity).toBe(25);
    expect(tankBatch.calculateDensity(tank.volume)).toBe(5);
    expect(tankBatch.canAddBatch(tank.maxDensity, tank.volume)).toBe(true);
    expect(tankBatch.getTotalBiomassIncludingCleanerFish()).toBe(500);
  });

  it('records initial stocking with AllocationType.INITIAL_STOCKING', () => {
    const allocation = Object.assign(new TankAllocation(), {
      id: 'allocation-1',
      tenantId,
      batchId: 'batch-1',
      batchNumber: 'B-2026-00001',
      tankId: 'tank-1',
      tankCode: 'T-001',
      tankName: 'Tank 1',
      allocationType: AllocationType.INITIAL_STOCKING,
      allocationDate: new Date('2026-01-01T00:00:00.000Z'),
      quantity: 5_000,
      avgWeightG: 100,
      biomassKg: 500,
      densityKgM3: 5,
      allocatedBy: 'user-1',
      isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(allocation.allocationType).toBe(AllocationType.INITIAL_STOCKING);
    expect(allocation.biomassKg).toBe(500);
    expect(allocation.densityKgM3).toBe(5);
  });

  it('represents transfer as paired allocation and operation directions', () => {
    const transferDate = new Date('2026-01-15T00:00:00.000Z');
    const sourceAllocation = Object.assign(new TankAllocation(), {
      tenantId,
      batchId: 'batch-1',
      tankId: 'tank-1',
      allocationType: AllocationType.TRANSFER_OUT,
      allocationDate: transferDate,
      quantity: -1_000,
      biomassKg: -100,
      avgWeightG: 100,
      isDeleted: false,
    });
    const destinationAllocation = Object.assign(new TankAllocation(), {
      tenantId,
      batchId: 'batch-1',
      tankId: 'tank-2',
      allocationType: AllocationType.TRANSFER_IN,
      allocationDate: transferDate,
      quantity: 1_000,
      biomassKg: 100,
      avgWeightG: 100,
      isDeleted: false,
    });
    const sourceOperation = Object.assign(new TankOperation(), {
      tenantId,
      batchId: 'batch-1',
      tankId: 'tank-1',
      destinationTankId: 'tank-2',
      operationType: OperationType.TRANSFER_OUT,
      operationDate: transferDate,
      quantity: 1_000,
      biomassKg: 100,
      avgWeightG: 100,
      performedBy: 'user-1',
      isDeleted: false,
    });
    const destinationOperation = Object.assign(new TankOperation(), {
      tenantId,
      batchId: 'batch-1',
      tankId: 'tank-2',
      sourceTankId: 'tank-1',
      operationType: OperationType.TRANSFER_IN,
      operationDate: transferDate,
      quantity: 1_000,
      biomassKg: 100,
      avgWeightG: 100,
      performedBy: 'user-1',
      isDeleted: false,
    });

    expect(sourceAllocation.allocationType).toBe(AllocationType.TRANSFER_OUT);
    expect(destinationAllocation.allocationType).toBe(AllocationType.TRANSFER_IN);
    expect(sourceOperation.operationType).toBe(OperationType.TRANSFER_OUT);
    expect(destinationOperation.operationType).toBe(OperationType.TRANSFER_IN);
  });

  it('tracks mixed batches through batchDetails instead of a removed batchId column', () => {
    const tankBatch = createTankBatch({
      isMixedBatch: true,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-2026-00001',
          quantity: 3_000,
          avgWeightG: 100,
          biomassKg: 300,
          percentageOfTank: 60,
        },
        {
          batchId: 'batch-2',
          batchNumber: 'B-2026-00002',
          quantity: 2_000,
          avgWeightG: 100,
          biomassKg: 200,
          percentageOfTank: 40,
        },
      ],
    });

    expect(tankBatch.isMixedBatch).toBe(true);
    expect(tankBatch.batchDetails).toHaveLength(2);
    expect(tankBatch.batchDetails?.map((detail) => detail.percentageOfTank)).toEqual([60, 40]);
  });
});
