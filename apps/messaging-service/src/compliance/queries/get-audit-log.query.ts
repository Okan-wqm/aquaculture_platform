import { IQuery } from '@nestjs/cqrs';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';

/**
 * Query to retrieve paginated compliance audit log entries.
 *
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
export class GetAuditLogQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly limit: number,
    public readonly cursor: string | null,
    public readonly userId: string | null,
    public readonly action: ComplianceAction | null,
    public readonly resourceType: string | null,
    public readonly startDate: Date | null,
    public readonly endDate: Date | null,
  ) {}
}
