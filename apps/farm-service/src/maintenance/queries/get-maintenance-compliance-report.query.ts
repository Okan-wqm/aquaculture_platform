/**
 * Get Maintenance Compliance Report Query
 */
import { IQuery } from '@platform/cqrs';

export class GetMaintenanceComplianceReportQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
