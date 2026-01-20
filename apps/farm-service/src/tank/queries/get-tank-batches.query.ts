/**
 * GetTankBatchesQuery
 *
 * Belirli bir tank'taki batch'leri getirir.
 *
 * @module Tank/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Tank'taki batch bilgisi
 */
export interface TankBatchInfo {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  densityKgM3: number;
  allocationDate: Date;
  isPrimary: boolean;
  batchStatus: string;
}

/**
 * Tank batch response
 */
export interface TankBatchesResult {
  tankId: string;
  tankCode: string;
  tankName: string;
  volumeM3: number;
  maxCapacityKg: number;
  currentBiomassKg: number;
  currentDensityKgM3: number;
  capacityUsedPercent: number;
  totalQuantity: number;
  batches: TankBatchInfo[];
  isMixed: boolean;
}

export class GetTankBatchesQuery implements ITenantQuery {
  readonly queryName = 'GetTankBatchesQuery';

  constructor(
    public readonly tenantId: string,
    public readonly tankId: string,
    public readonly includeInactive?: boolean,
  ) {}
}
