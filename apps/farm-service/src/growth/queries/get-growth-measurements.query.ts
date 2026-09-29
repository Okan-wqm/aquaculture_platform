/**
 * GetGrowthMeasurementsQuery
 *
 * Büyüme ölçümlerini filtrelenmiş olarak getirir.
 *
 * @module Growth/Queries
 */
import { IPaginatedQuery } from '@platform/cqrs';
import { MeasurementType, GrowthPerformance } from '../entities/growth-measurement.entity';
import type { TenantScope } from '@aquaculture/backend-common/database';

/**
 * Ölçüm filtresi
 */
export interface GrowthMeasurementFilter {
  batchId?: string;
  tankId?: string;
  measurementType?: MeasurementType[];
  performance?: GrowthPerformance[];
  fromDate?: Date;
  toDate?: Date;
  isVerified?: boolean;
  measuredBy?: string;
}

export class GetGrowthMeasurementsQuery implements IPaginatedQuery {
  readonly queryName = 'GetGrowthMeasurementsQuery';

  constructor(
    public readonly scope: TenantScope,
    public readonly filter?: GrowthMeasurementFilter,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'measurementDate',
    public readonly sortOrder: 'ASC' | 'DESC' = 'DESC',
  ) {}
}
