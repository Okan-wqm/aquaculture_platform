/**
 * Projection spec for the tank farm-AI responder (PR-4): shape fidelity for
 * the capacity aggregate (already PII-free handler output).
 */
import { projectTankCapacity } from '../projections';
import { TankCapacityResult } from '../../queries/get-tank-capacity.query';

const CAPACITY: TankCapacityResult = {
  tankId: 't1',
  tankCode: 'TNK-001',
  tankName: 'Havuz 1',
  volumeM3: 120,
  maxCapacityKg: 12000,
  maxDensityKgM3: 100,
  optimalDensityMinKgM3: 40,
  optimalDensityMaxKgM3: 70,
  currentQuantity: 9500,
  currentBiomassKg: 3400,
  currentDensityKgM3: 28.3,
  currentAvgWeightG: 358,
  capacityUsedKg: 3400,
  capacityAvailableKg: 8600,
  capacityUsedPercent: 28.3,
  densityStatus: 'low',
  capacityStatus: 'available',
  batchCount: 1,
  primaryBatchId: 'b1',
  primaryBatchNumber: 'B-2026-001',
  warnings: ['Density below optimal band'],
};

describe('tank farm-AI projections (PR-4 read-only namespace)', () => {
  it('passes the aggregate through with string statuses', () => {
    const projection = projectTankCapacity(CAPACITY);
    expect(projection).toMatchObject({
      tankCode: 'TNK-001',
      volumeM3: 120,
      currentBiomassKg: 3400,
      capacityUsedPercent: 28.3,
      densityStatus: 'low',
      capacityStatus: 'available',
      primaryBatchNumber: 'B-2026-001',
    });
    expect(projection.warnings).toEqual(['Density below optimal band']);
  });

  it('null-safes optional batch attribution', () => {
    const projection = projectTankCapacity({
      ...CAPACITY,
      primaryBatchId: undefined,
      primaryBatchNumber: undefined,
    });
    expect(projection.primaryBatchId).toBeNull();
    expect(projection.primaryBatchNumber).toBeNull();
  });
});
