/**
 * List Upcoming Harvest Plans Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListUpcomingHarvestPlansQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly days: number = 30,
  ) {}
}
