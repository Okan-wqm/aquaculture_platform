/**
 * Get Maintenance Schedule (by id) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetMaintenanceScheduleQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
