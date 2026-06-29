/**
 * List Maintenance Schedule Alerts Query (schedules requiring an alert).
 */
import { IQuery } from '@platform/cqrs';

export class ListMaintenanceScheduleAlertsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
