import { Controller, Get, Query, Param, Req, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { PaginationQueryDto } from '../shared/pagination-query.dto';
import { getAuthUser, requireAuthUserId } from '../shared/authenticated-request';
import { clampLimit } from '../shared/sort-field.util';

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
  private writeMetaAudit(req: Request, action: string, details: Record<string, unknown>): void {
    this.auditLogService
      .log({
        action: 'AUDIT_LOG_ACCESSED',
        entityType: 'AuditLog',
        // The trace exists to name the insider; 'unknown' would defeat it.
        performedBy: requireAuthUserId(req),
        ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
        userAgent: req.headers['user-agent'],
        details: { subAction: action, ...details },
      })
      .catch(() => {
        // Meta-audit failure must not block the primary audit read
      });
  }

  @Get()
  async queryAuditLogs(
    @Req() req: Request,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('tenantId') tenantId?: string,
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
    this.writeMetaAudit(req, 'QUERY', { filter: { action, entityType, tenantId, severity } });

    return this.auditLogService.query(filter, pagination?.page ?? 1, pagination?.limit ?? 50);
  }

  @Get('entity/:entityType/:entityId')
  async getEntityHistory(
    @Req() req: Request,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    // ADMIN-MEDIUM-003: meta-audit
    this.writeMetaAudit(req, 'ENTITY_HISTORY', { entityType, entityId });
    // SEC-MEDIUM №17 (2026-08-23 scan): clamp before .take()
    return this.auditLogService.getEntityHistory(entityType, entityId, clampLimit(limit, 100));
  }

  @Get('user/:userId')
  async getUserActivity(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    // ADMIN-MEDIUM-003: meta-audit
    this.writeMetaAudit(req, 'USER_ACTIVITY', { targetUserId: userId });
    return this.auditLogService.getUserActivity(
      userId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
      // SEC-MEDIUM №17 (2026-08-23 scan): clamp before .take()
      clampLimit(limit, 100),
    );
  }

  @Get('security')
  async getSecurityLogs(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    // ADMIN-MEDIUM-003: meta-audit -- security log access is especially sensitive
    this.writeMetaAudit(req, 'SECURITY_LOGS', { tenantId });
    // SEC-MEDIUM №17 (2026-08-23 scan): clamp before .take()
    return this.auditLogService.getSecurityLogs(tenantId, clampLimit(limit, 100));
  }

  @Get('statistics')
  async getStatistics(
    @Query('tenantId') tenantId?: string,
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
