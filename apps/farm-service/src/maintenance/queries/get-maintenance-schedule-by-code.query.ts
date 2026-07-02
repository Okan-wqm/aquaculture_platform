/**
 * Get Maintenance Schedule (by code) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetMaintenanceScheduleByCodeQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly code: string,
  ) {}
}
