/**
 * Get Biomass Report by period Query
 */
import { IQuery } from '@platform/cqrs';

export class GetBiomassReportByPeriodQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
    public readonly reportMonth: number,
    public readonly reportYear: number,
  ) {}
}
