/**
 * List Maintenance Schedule Alerts Query (schedules requiring an alert).
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListMaintenanceScheduleAlertsQuery {
  constructor(public readonly scope: TenantScope) {}
}
