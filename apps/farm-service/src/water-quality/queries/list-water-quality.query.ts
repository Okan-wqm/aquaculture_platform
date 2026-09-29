/**
 * List Water Quality Measurements Query
 */
import { WaterQualityFilters } from '../water-quality.service';
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListWaterQualityQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly filters: WaterQualityFilters = {},
  ) {}
}
