/**
 * Get Work Order Statistics Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetWorkOrderStatisticsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly dateFrom?: Date,
    public readonly dateTo?: Date,
  ) {}
}
