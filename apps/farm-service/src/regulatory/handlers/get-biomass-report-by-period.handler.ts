/**
 * Get Biomass Report by period Query Handler — fail-closed tenant boundary.
 * Returns null when absent (the GraphQL field is nullable).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { BiomassReport } from '../entities/biomass-report.entity';
import { GetBiomassReportByPeriodQuery } from '../queries/get-biomass-report-by-period.query';

@QueryHandler(GetBiomassReportByPeriodQuery)
export class GetBiomassReportByPeriodHandler
  implements IQueryHandler<GetBiomassReportByPeriodQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetBiomassReportByPeriodQuery): Promise<BiomassReport | null> {
    const { tenantId, siteId, reportMonth, reportYear } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(BiomassReport, {
        where: { tenantId, siteId, reportMonth, reportYear },
      }),
    );
  }
}
