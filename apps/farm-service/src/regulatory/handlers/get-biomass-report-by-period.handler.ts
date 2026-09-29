/**
 * Get Biomass Report by period Query Handler — fail-closed tenant boundary.
 * Returns null when absent (the GraphQL field is nullable).
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { BiomassReport } from '../entities/biomass-report.entity';
import { GetBiomassReportByPeriodQuery } from '../queries/get-biomass-report-by-period.query';

@QueryHandler(GetBiomassReportByPeriodQuery)
export class GetBiomassReportByPeriodHandler
  implements IQueryHandler<GetBiomassReportByPeriodQuery>
{
  async execute(query: GetBiomassReportByPeriodQuery): Promise<BiomassReport | null> {
    const { scope, siteId, reportMonth, reportYear } = query;
    const tenantId = scope.tenantId;
    return scope.manager.findOne(BiomassReport, {
      where: { tenantId, siteId, reportMonth, reportYear },
    });
  }
}
