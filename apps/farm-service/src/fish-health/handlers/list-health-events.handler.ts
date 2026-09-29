/**
 * List Health Events (filtered, paginated) Query Handler — fail-closed tenant
 * boundary. Reuses applyHealthEventFilters (the filter SSoT) so the filter
 * logic is not duplicated.
 */
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { HealthEvent } from '../entities/health-event.entity';
import { applyHealthEventFilters } from '../services/health-event-filters';
import { ListHealthEventsQuery } from '../queries/list-health-events.query';

@QueryHandler(ListHealthEventsQuery)
export class ListHealthEventsHandler implements IQueryHandler<ListHealthEventsQuery> {
  async execute(query: ListHealthEventsQuery): Promise<IStandardPaginatedResult<HealthEvent>> {
    const { scope, filter } = query;
    const tenantId = scope.tenantId;

    const qb = scope.manager
      .createQueryBuilder(HealthEvent, 'he')
      .where('he.tenantId = :tenantId', { tenantId });

    applyHealthEventFilters(qb, filter);

    const total = await qb.getCount();

    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    qb.skip(offset).take(limit);

    const sortBy = filter?.sortBy ?? 'eventDate';
    const sortDir = filter?.sortDirection ?? 'DESC';
    const validSortFields = ['eventDate', 'type', 'severity', 'status', 'createdAt', 'updatedAt'];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'eventDate';
    qb.orderBy(`he.${safeSortBy}`, sortDir);

    const items = await qb.getMany();
    const page = Math.floor(offset / limit) + 1;

    return createStandardPaginatedResult(items, total, page, limit);
  }
}
