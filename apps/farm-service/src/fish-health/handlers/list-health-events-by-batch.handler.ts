/**
 * List Health Events for a batch Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, FindOptionsWhere } from 'typeorm';

import { HealthEvent, HealthEventStatus } from '../entities/health-event.entity';
import { ListHealthEventsByBatchQuery } from '../queries/list-health-events-by-batch.query';

@QueryHandler(ListHealthEventsByBatchQuery)
export class ListHealthEventsByBatchHandler
  implements IQueryHandler<ListHealthEventsByBatchQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListHealthEventsByBatchQuery): Promise<HealthEvent[]> {
    const { tenantId, batchId, activeOnly } = query;
    const where: FindOptionsWhere<HealthEvent> = { tenantId, batchId };

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      if (activeOnly) {
        return queryRunner.manager.find(HealthEvent, {
          where: [
            { ...where, status: HealthEventStatus.ACTIVE },
            { ...where, status: HealthEventStatus.MONITORING },
          ],
          order: { eventDate: 'DESC' },
        });
      }
      return queryRunner.manager.find(HealthEvent, { where, order: { eventDate: 'DESC' } });
    });
  }
}
