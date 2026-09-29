/**
 * Get System Water Quality Statistics Query (aggregate over all tanks in a system)
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetSystemWaterQualityStatisticsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly systemId: string,
    public readonly days: number = 7,
  ) {}
}
