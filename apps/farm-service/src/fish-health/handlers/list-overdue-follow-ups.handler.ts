/**
 * List Health Events with overdue follow-ups Query Handler — fail-closed tenant
 * boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { HealthEvent, HealthEventStatus } from '../entities/health-event.entity';
import { ListOverdueFollowUpsQuery } from '../queries/list-overdue-follow-ups.query';

@QueryHandler(ListOverdueFollowUpsQuery)
export class ListOverdueFollowUpsHandler implements IQueryHandler<ListOverdueFollowUpsQuery> {
  async execute(query: ListOverdueFollowUpsQuery): Promise<HealthEvent[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    return scope.manager
      .createQueryBuilder(HealthEvent, 'he')
      .where('he.tenantId = :tenantId', { tenantId })
      .andWhere('he.followUpRequired = true')
      .andWhere('he.nextFollowUpDate < :now', { now: new Date() })
      .andWhere('he.status IN (:...statuses)', {
        statuses: [HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING],
      })
      .orderBy('he.nextFollowUpDate', 'ASC')
      .getMany();
  }
}
