/**
 * Get Biomass Report by period Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetBiomassReportByPeriodQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly siteId: string,
    public readonly reportMonth: number,
    public readonly reportYear: number,
  ) {}
}
