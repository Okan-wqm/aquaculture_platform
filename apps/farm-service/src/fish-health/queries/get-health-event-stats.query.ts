/**
 * Get Health Event Statistics Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetHealthEventStatsQuery {
  constructor(public readonly scope: TenantScope) {}
}
