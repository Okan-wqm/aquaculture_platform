/**
 * List Biomass Reports for a site Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { BiomassReport } from '../entities/biomass-report.entity';
import { ListBiomassReportsForSiteQuery } from '../queries/list-biomass-reports-for-site.query';

@QueryHandler(ListBiomassReportsForSiteQuery)
export class ListBiomassReportsForSiteHandler
  implements IQueryHandler<ListBiomassReportsForSiteQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListBiomassReportsForSiteQuery): Promise<BiomassReport[]> {
    const { tenantId, siteId, limit } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(BiomassReport, {
        where: { tenantId, siteId },
        order: { reportYear: 'DESC', reportMonth: 'DESC' },
        take: Math.min(Math.max(limit, 1), 120),
      }),
    );
  }
}
