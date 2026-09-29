/**
 * Get Health Event Statistics Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  HealthEvent,
  HealthEventStatus,
  HealthSeverity,
} from '../entities/health-event.entity';
import { HealthEventStats } from '../services/health-event.service';
import { GetHealthEventStatsQuery } from '../queries/get-health-event-stats.query';

@QueryHandler(GetHealthEventStatsQuery)
export class GetHealthEventStatsHandler implements IQueryHandler<GetHealthEventStatsQuery> {
  async execute(query: GetHealthEventStatsQuery): Promise<HealthEventStats> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const events = await scope.manager.find(HealthEvent, { where: { tenantId } });

    const stats: HealthEventStats = {
      total: events.length,
      active: 0,
      critical: 0,
      underTreatment: 0,
      quarantined: 0,
      resolved: 0,
      byEventType: {},
      bySeverity: {},
    };

    for (const event of events) {
      if (
        event.status === HealthEventStatus.ACTIVE ||
        event.status === HealthEventStatus.MONITORING
      ) {
        stats.active++;
      }
      if (event.status === HealthEventStatus.RESOLVED) {
        stats.resolved++;
      }
      if (event.isUnderTreatment) {
        stats.underTreatment++;
      }
      if (event.isQuarantined) {
        stats.quarantined++;
      }
      if (
        event.severity === HealthSeverity.CRITICAL ||
        event.severity === HealthSeverity.SEVERE
      ) {
        stats.critical++;
      }

      stats.byEventType[event.eventType] = (stats.byEventType[event.eventType] ?? 0) + 1;
      stats.bySeverity[event.severity] = (stats.bySeverity[event.severity] ?? 0) + 1;
    }

    return stats;
  }
}
