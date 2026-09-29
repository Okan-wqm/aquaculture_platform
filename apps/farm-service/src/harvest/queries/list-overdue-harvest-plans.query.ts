/**
 * List Overdue Harvest Plans Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListOverdueHarvestPlansQuery {
  constructor(public readonly scope: TenantScope) {}
}
