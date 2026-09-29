/**
 * List Critical Health Events Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { In } from 'typeorm';

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
  async execute(query: ListCriticalHealthEventsQuery): Promise<HealthEvent[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    return scope.manager.find(HealthEvent, {
      where: {
        tenantId,
        severity: In([HealthSeverity.CRITICAL, HealthSeverity.SEVERE]),
        status: In([HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING]),
      },
      order: { eventDate: 'DESC' },
    });
  }
}
