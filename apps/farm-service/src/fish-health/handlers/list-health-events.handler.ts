/**
 * List Health Events (filtered, paginated) Query Handler — fail-closed tenant
 * boundary. Reuses HealthEventService.applyFilters (static SSoT) so the filter
 * logic is not duplicated.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HealthEvent } from '../entities/health-event.entity';
import { HealthEventService } from '../services/health-event.service';
import { ListHealthEventsQuery } from '../queries/list-health-events.query';

@QueryHandler(ListHealthEventsQuery)
export class ListHealthEventsHandler implements IQueryHandler<ListHealthEventsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListHealthEventsQuery): Promise<IStandardPaginatedResult<HealthEvent>> {
    const { tenantId, filter } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(HealthEvent, 'he')
        .where('he.tenantId = :tenantId', { tenantId });

      HealthEventService.applyFilters(qb, filter);

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
    });
  }
}
