/**
 * Get one regulatory report submission Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { RegulatoryReport } from '../entities/regulatory-report.entity';
import { GetRegulatoryReportQuery } from '../queries/get-regulatory-report.query';

@QueryHandler(GetRegulatoryReportQuery)
export class GetRegulatoryReportHandler implements IQueryHandler<GetRegulatoryReportQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetRegulatoryReportQuery): Promise<RegulatoryReport | null> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(RegulatoryReport, { where: { id, tenantId } }),
    );
  }
}
