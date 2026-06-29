/**
 * List Critical Health Events Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In } from 'typeorm';

import {
  HealthEvent,
  HealthEventStatus,
  HealthSeverity,
} from '../entities/health-event.entity';
import { ListCriticalHealthEventsQuery } from '../queries/list-critical-health-events.query';

@QueryHandler(ListCriticalHealthEventsQuery)
export class ListCriticalHealthEventsHandler
  implements IQueryHandler<ListCriticalHealthEventsQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListCriticalHealthEventsQuery): Promise<HealthEvent[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(HealthEvent, {
        where: {
          tenantId,
          severity: In([HealthSeverity.CRITICAL, HealthSeverity.SEVERE]),
          status: In([HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING]),
        },
        order: { eventDate: 'DESC' },
      }),
    );
  }
}
