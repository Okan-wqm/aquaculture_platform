/**
 * List Low-Stock Alerts Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListLowStockAlertsQuery {
  constructor(public readonly scope: TenantScope) {}
}
