/**
 * Get Harvest Plan Statistics Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetHarvestPlanStatsQuery {
  constructor(public readonly scope: TenantScope) {}
}
