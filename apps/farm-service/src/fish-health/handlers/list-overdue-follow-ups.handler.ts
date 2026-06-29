/**
 * List Health Events with overdue follow-ups Query Handler — fail-closed tenant
 * boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HealthEvent, HealthEventStatus } from '../entities/health-event.entity';
import { ListOverdueFollowUpsQuery } from '../queries/list-overdue-follow-ups.query';

@QueryHandler(ListOverdueFollowUpsQuery)
export class ListOverdueFollowUpsHandler implements IQueryHandler<ListOverdueFollowUpsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListOverdueFollowUpsQuery): Promise<HealthEvent[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(HealthEvent, 'he')
        .where('he.tenantId = :tenantId', { tenantId })
        .andWhere('he.followUpRequired = true')
        .andWhere('he.nextFollowUpDate < :now', { now: new Date() })
        .andWhere('he.status IN (:...statuses)', {
          statuses: [HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING],
        })
        .orderBy('he.nextFollowUpDate', 'ASC')
        .getMany(),
    );
  }
}
