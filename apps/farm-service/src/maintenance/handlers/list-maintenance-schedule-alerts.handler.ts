/**
 * List Maintenance Schedule Alerts Query Handler — fail-closed tenant boundary.
 * Loads active schedules and derives overdue/due-today/upcoming alerts.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
} from '../entities/maintenance-schedule.entity';
import { ScheduleAlert } from '../services/maintenance-schedule.service';
import { ListMaintenanceScheduleAlertsQuery } from '../queries/list-maintenance-schedule-alerts.query';

@QueryHandler(ListMaintenanceScheduleAlertsQuery)
export class ListMaintenanceScheduleAlertsHandler
  implements IQueryHandler<ListMaintenanceScheduleAlertsQuery>
{
  async execute(query: ListMaintenanceScheduleAlertsQuery): Promise<ScheduleAlert[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const schedules = await scope.manager.find(MaintenanceSchedule, {
      where: { tenantId, status: MaintenanceScheduleStatus.ACTIVE },
    });

    const alerts: ScheduleAlert[] = [];
    for (const schedule of schedules) {
      if (!schedule.nextDueDate) continue;
      const daysUntilDue = schedule.getDaysUntilDue();
      if (daysUntilDue < 0) {
        alerts.push({ schedule, daysUntilDue, alertType: 'overdue' });
      } else if (daysUntilDue === 0) {
        alerts.push({ schedule, daysUntilDue, alertType: 'due_today' });
      } else if (schedule.shouldAlert()) {
        alerts.push({ schedule, daysUntilDue, alertType: 'upcoming' });
      }
    }

    return alerts.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  }
}
