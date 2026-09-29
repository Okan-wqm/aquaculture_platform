/**
 * List Critical Water Quality Tanks Query (life-safety surface).
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListCriticalWaterQualityQuery {
  constructor(public readonly scope: TenantScope) {}
}
