import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';

import { GetAuditLogQuery } from './get-audit-log.query';
import {
  ComplianceAuditService,
  AuditLogFilters,
  AuditLogPage,
} from '../services/compliance-audit.service';

/**
 * Handler for GetAuditLogQuery.
 *
 * Delegates to ComplianceAuditService with cursor-based pagination.
 *
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
@QueryHandler(GetAuditLogQuery)
export class GetAuditLogHandler
  implements IQueryHandler<GetAuditLogQuery, AuditLogPage>
{
  private readonly logger = new Logger(GetAuditLogHandler.name);

  constructor(private readonly auditService: ComplianceAuditService) {}

  async execute(query: GetAuditLogQuery): Promise<AuditLogPage> {
    const filters: AuditLogFilters = {
      tenantId: query.tenantId,
    };

    if (query.userId) filters.userId = query.userId;
    if (query.action) filters.action = query.action;
    if (query.resourceType) filters.resourceType = query.resourceType;
    if (query.startDate) filters.startDate = query.startDate;
    if (query.endDate) filters.endDate = query.endDate;

    const result = await this.auditService.getAuditLog(
      filters,
      query.limit,
      query.cursor,
    );

    this.logger.debug(
      `GetAuditLog: tenant=${query.tenantId}, returned=${result.items.length}, hasMore=${result.hasMore}`,
    );

    return result;
  }
}
