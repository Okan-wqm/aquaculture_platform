/**
 * GetTankCapacityQuery
 *
 * Tank kapasite ve yoğunluk bilgilerini döner.
 *
 * @module Tank/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Tank kapasite durumu
 */
export interface TankCapacityResult {
  tankId: string;
  tankCode: string;
  tankName: string;

  // Fiziksel özellikler
  volumeM3: number;
  maxCapacityKg: number;
  maxDensityKgM3: number;
  optimalDensityMinKgM3: number;
  optimalDensityMaxKgM3: number;

  // Mevcut durum
  currentQuantity: number;
  currentBiomassKg: number;
  currentDensityKgM3: number;
  currentAvgWeightG: number;

  // Kapasite kullanımı
  capacityUsedKg: number;
  capacityAvailableKg: number;
  capacityUsedPercent: number;

  // Durum değerlendirmesi
  densityStatus: 'optimal' | 'low' | 'high' | 'critical';
  capacityStatus: 'available' | 'near_capacity' | 'full' | 'over_capacity';

  // Batch bilgisi
  batchCount: number;
  primaryBatchId?: string;
  primaryBatchNumber?: string;

  // Uyarılar
  warnings: string[];
}

export class GetTankCapacityQuery implements ITenantQuery {
  readonly queryName = 'GetTankCapacityQuery';

  constructor(
    public readonly tenantId: string,
    public readonly tankId: string,
  ) {}
}
