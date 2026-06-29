/**
 * List Maintenance Schedules (filtered, paginated) Query
 */
import { IQuery } from '@platform/cqrs';
import { MaintenanceScheduleFilterInput } from '../dto/maintenance-schedule-filter.dto';

export class ListMaintenanceSchedulesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: MaintenanceScheduleFilterInput,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'nextDueDate',
    public readonly sortOrder: 'ASC' | 'DESC' = 'ASC',
  ) {}
}
