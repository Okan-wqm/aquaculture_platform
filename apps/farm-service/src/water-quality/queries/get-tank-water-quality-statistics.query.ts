/**
 * Get Tank Water Quality Statistics Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetTankWaterQualityStatisticsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly tankId: string,
    public readonly days: number = 7,
  ) {}
}
