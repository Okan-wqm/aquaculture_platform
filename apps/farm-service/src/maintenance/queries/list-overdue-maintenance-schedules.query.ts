/**
 * List Overdue Maintenance Schedules Query
 */
import { IQuery } from '@platform/cqrs';

export class ListOverdueMaintenanceSchedulesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
