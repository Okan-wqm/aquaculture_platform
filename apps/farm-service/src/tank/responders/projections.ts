/**
 * PURE projection for the tank farm-AI responder (PR-4, Production
 * specialist — TANK_CAPACITY is shared with the Operations specialist).
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata and NO operator PII — TankCapacityResult is already
 *    an aggregate, so the projection only re-asserts types/units.
 */
import { TankCapacityResult } from '../queries/get-tank-capacity.query';

/** Tank capacity + density DTO. */
export interface TankCapacityDto {
  tankId: string;
  tankCode: string;
  tankName: string;
  volumeM3: number;
  maxCapacityKg: number;
  maxDensityKgM3: number;
  optimalDensityMinKgM3: number;
  optimalDensityMaxKgM3: number;
  currentQuantity: number;
  currentBiomassKg: number;
  currentDensityKgM3: number;
  currentAvgWeightG: number;
  capacityUsedKg: number;
  capacityAvailableKg: number;
  capacityUsedPercent: number;
  densityStatus: string;
  capacityStatus: string;
  batchCount: number;
  primaryBatchId: string | null;
  primaryBatchNumber: string | null;
  warnings: string[];
}

/** Project the tank capacity aggregate (warnings are system-generated). */
export function projectTankCapacity(result: TankCapacityResult): TankCapacityDto {
  return {
    tankId: result.tankId,
    tankCode: result.tankCode,
    tankName: result.tankName,
    volumeM3: result.volumeM3,
    maxCapacityKg: result.maxCapacityKg,
    maxDensityKgM3: result.maxDensityKgM3,
    optimalDensityMinKgM3: result.optimalDensityMinKgM3,
    optimalDensityMaxKgM3: result.optimalDensityMaxKgM3,
    currentQuantity: result.currentQuantity,
    currentBiomassKg: result.currentBiomassKg,
    currentDensityKgM3: result.currentDensityKgM3,
    currentAvgWeightG: result.currentAvgWeightG,
    capacityUsedKg: result.capacityUsedKg,
    capacityAvailableKg: result.capacityAvailableKg,
    capacityUsedPercent: result.capacityUsedPercent,
    densityStatus: String(result.densityStatus),
    capacityStatus: String(result.capacityStatus),
    batchCount: result.batchCount,
    primaryBatchId: result.primaryBatchId ?? null,
    primaryBatchNumber: result.primaryBatchNumber ?? null,
    warnings: (result.warnings ?? []).slice(),
  };
}
