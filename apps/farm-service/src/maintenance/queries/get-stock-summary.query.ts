/**
 * Get Spare-Part Stock Summary Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetStockSummaryQuery {
  constructor(public readonly scope: TenantScope) {}
}
