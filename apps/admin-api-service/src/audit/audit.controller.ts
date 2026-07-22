import {
  Controller,
  Get,
  Query,
  Param,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { getAuthUser } from '../shared/authenticated-request';

import { AuditAction, AuditLog } from './audit.entity';
import { AuditLogService, AuditLogFilter } from './audit.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

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
    const user = getAuthUser(req);
    this.auditLogService.log({
      action: AuditAction.AUDIT_LOG_ACCESSED,
      entityType: 'AuditLog',
      performedBy: user?.id || 'unknown',
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
      userAgent: req.headers['user-agent'],
      details: { subAction: action, ...details },
    }).catch(() => {
      // Meta-audit failure must not block the primary audit read
    });
  }

  @Get()
  async queryAuditLogs(
    @Req() req: Request,
    @Query() query: AuditLogQueryDto,
  ): Promise<unknown> {
    const filter: AuditLogFilter = {
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      tenantId: query.tenantId,
      performedBy: query.performedBy,
      severity: query.severity,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      search: query.search,
    };

    // ADMIN-MEDIUM-003: meta-audit -- record that audit logs were queried
    this.writeMetaAudit(req, 'QUERY', {
      filter: {
        action: query.action,
        entityType: query.entityType,
        tenantId: query.tenantId,
        severity: query.severity,
      },
    });

    return this.auditLogService.query(filter, query.page ?? 1, query.limit ?? 50);
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
    return this.auditLogService.getEntityHistory(
      entityType,
      entityId,
      limit ? parseInt(limit, 10) : 100,
    );
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
      limit ? parseInt(limit, 10) : 100,
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
    return this.auditLogService.getSecurityLogs(
      tenantId,
      limit ? parseInt(limit, 10) : 100,
    );
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
