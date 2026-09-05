import { TenantParam } from '@aquaculture/backend-common/decorators';
import {
  Controller,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../shared/pagination-query.dto';

import { AuditLog, AuditSeverity } from './audit.entity';
import { AuditLogService, AuditLogFilter } from './audit.service';

@ApiTags('Security')
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  /**
   * ADMIN-MEDIUM-003: Write a meta-audit entry when audit logs are read.
   * An admin reading sensitive audit entries must leave a trace. Without
   * this, an insider could read audit data without detection.
   */
  private async writeMetaAudit(action: string, details: Record<string, unknown>): Promise<void> {
    // Awaited and fail-closed (ADMIN-CRITICAL-008): an audit read whose own
    // trace cannot be written does not return the data. The actor is the
    // guard-verified principal in the request frame, never a caller string.
    await this.auditLogService.record({
      action: 'AUDIT_LOG_ACCESSED',
      entityType: 'AuditLog',
      details: { subAction: action, ...details },
    });
  }

  @Get()
  async queryAuditLogs(
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @TenantParam('query', { optional: true }) tenantId?: string,
    @Query('performedBy') performedBy?: string,
    @Query('severity') severity?: AuditSeverity,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    const filter: AuditLogFilter = {
      action,
      entityType,
      entityId,
      tenantId,
      performedBy,
      severity,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      search,
    };

    // ADMIN-MEDIUM-003: meta-audit -- record that audit logs were queried
    await this.writeMetaAudit('QUERY', { filter: { action, entityType, tenantId, severity } });

    return this.auditLogService.query(
      filter,
      pagination?.page ?? 1,
      pagination?.limit ?? 50,
    );
  }

  @Get('entity/:entityType/:entityId')
  async getEntityHistory(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    // ADMIN-MEDIUM-003: meta-audit
    await this.writeMetaAudit('ENTITY_HISTORY', { entityType, entityId });
    return this.auditLogService.getEntityHistory(
      entityType,
      entityId,
      limit ? parseInt(limit, 10) : 100,
    );
  }

  @Get('user/:userId')
  async getUserActivity(
    @Param('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    // ADMIN-MEDIUM-003: meta-audit
    await this.writeMetaAudit('USER_ACTIVITY', { targetUserId: userId });
    return this.auditLogService.getUserActivity(
      userId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
      limit ? parseInt(limit, 10) : 100,
    );
  }

  @Get('security')
  async getSecurityLogs(
    @TenantParam('query', { optional: true }) tenantId?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    // ADMIN-MEDIUM-003: meta-audit -- security log access is especially sensitive
    await this.writeMetaAudit('SECURITY_LOGS', { tenantId });
    return this.auditLogService.getSecurityLogs(
      tenantId,
      limit ? parseInt(limit, 10) : 100,
    );
  }

  @Get('statistics')
  async getStatistics(
    @TenantParam('query', { optional: true }) tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.auditLogService.getStatistics(
      tenantId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }
}
