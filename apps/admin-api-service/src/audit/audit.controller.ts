import {
  Controller,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { AuditLogService, AuditLogFilter } from './audit.service';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import { AuditLog, AuditSeverity } from './audit.entity';

@Controller('audit-logs')
@UseGuards(PlatformAdminGuard)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  async queryAuditLogs(
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('performedBy') performedBy?: string,
    @Query('severity') severity?: AuditSeverity,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
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

    return this.auditLogService.query(
      filter,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('entity/:entityType/:entityId')
  async getEntityHistory(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
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
    return this.auditLogService.getUserActivity(
      userId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
      limit ? parseInt(limit, 10) : 100,
    );
  }

  @Get('security')
  async getSecurityLogs(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
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
