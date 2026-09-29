/**
 * List Overdue Work Orders Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListOverdueWorkOrdersQuery {
  constructor(public readonly scope: TenantScope) {}
}
