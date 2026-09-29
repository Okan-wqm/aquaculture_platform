/**
 * Get Task Stats Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetTaskStatsQuery {
  constructor(public readonly scope: TenantScope) {}
}
