/**
 * List Health Events with overdue follow-ups Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListOverdueFollowUpsQuery {
  constructor(public readonly scope: TenantScope) {}
}
