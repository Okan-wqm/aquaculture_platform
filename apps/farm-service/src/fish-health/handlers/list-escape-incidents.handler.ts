/**
 * List Escape Incidents Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { EscapeIncident } from '../entities/escape-incident.entity';
import { ListEscapeIncidentsQuery } from '../queries/list-escape-incidents.query';

@QueryHandler(ListEscapeIncidentsQuery)
export class ListEscapeIncidentsHandler implements IQueryHandler<ListEscapeIncidentsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListEscapeIncidentsQuery): Promise<EscapeIncident[]> {
    const { tenantId, siteId, status } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(EscapeIncident, 'ei')
        .where('ei.tenantId = :tenantId', { tenantId });

      if (siteId) qb.andWhere('ei.siteId = :siteId', { siteId });
      if (status) qb.andWhere('ei.status = :status', { status });

      return qb.orderBy('ei.detectedAt', 'DESC').take(500).getMany();
    });
  }
}
