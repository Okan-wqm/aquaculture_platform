/**
 * List Upcoming Maintenance Schedules Query
 */
import { IQuery } from '@platform/cqrs';

export class ListUpcomingMaintenanceSchedulesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly days: number = 7,
  ) {}
}
