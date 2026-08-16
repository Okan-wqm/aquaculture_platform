import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Post,
  Query,
  Param,
  Body,
  Req,
  Res,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Request, Response } from 'express';
import {
  createAdminAttachmentFilename,
  isAdminAuditAction,
  isAdminAuditSeverity,
  type AdminAuditAction,
} from '@platform/admin-http-contracts';
import { ThrottleExport } from '@aquaculture/backend-common/security';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

import { PaginationQueryDto } from '../shared/pagination-query.dto';
import { getAuthUser } from '../shared/authenticated-request';

import { AuditLogDto, AuditSeverity, AuditStatisticsDto, toAuditLogDto } from './dto/audit-log.dto';
import { AuditLogService, AuditLogFilter } from './audit.service';
import {
  AdminManualResponse,
  AdminResponseContract,
} from '../shared/admin-response-contract.decorator';
import { sendAdminBinaryResponse } from '../shared/admin-manual-response.sender';
import {
  auditLogExportProfile,
  auditLogAuditLogDtoPageContract,
  type AuditLogAuditLogDtoDto,
  auditLogAuditLogDtoArrayContract,
  auditLogAuditStatisticsDtoContract,
  type AuditLogAuditStatisticsDtoDto,
} from './contracts/admin-http-response.contract';
import { parseAuditDateBoundary } from './audit-date-boundary';

class ExportAuditLogsDto {
  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  performedBy?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

function auditCsvCell(value: unknown): string {
  const raw = String(value ?? '');
  const protectedValue = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

@ApiTags('Security')
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  /**
   * ADMIN-MEDIUM-003: Write a meta-audit entry when audit logs are read.
   * An admin reading sensitive audit entries must leave a trace. Without
   * this, an insider could read audit data without detection.
   */
  private async writeMetaAudit(
    req: Request,
    subAction: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new ForbiddenException('Verified admin identity is required to read audit evidence');
    }
    const userAgentHeader = req.headers['user-agent'];
    await this.auditLogService.appendBeforeDisclosure({
      action: 'AUDIT_LOG_ACCESSED',
      entityType: 'AuditLog',
      performedBy: user.id,
      performedByEmail: user.email,
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(',') : userAgentHeader,
      details: { subAction, ...details },
    });
  }

  @AdminResponseContract(auditLogAuditLogDtoPageContract)
  @Get()
  async queryAuditLogs(
    @Req() req: Request,
    @Query('action') rawAction?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('performedBy') performedBy?: string,
    @Query('severity') rawSeverity?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<AuditLogAuditLogDtoDto>> {
    const action = this.parseAction(rawAction);
    const severity = this.parseSeverity(rawSeverity);
    const filter: AuditLogFilter = {
      action,
      entityType,
      entityId,
      tenantId,
      performedBy,
      severity,
      startDate: parseAuditDateBoundary(startDate, 'startDate'),
      endDate: parseAuditDateBoundary(endDate, 'endDate'),
      search,
    };

    // ADMIN-MEDIUM-003: meta-audit -- record that audit logs were queried
    await this.writeMetaAudit(req, 'QUERY', {
      filter: { action, entityType, tenantId, severity },
    });

    const result = await this.auditLogService.query(
      filter,
      pagination?.page ?? 1,
      pagination?.limit ?? 50,
    );
    return createStandardPaginatedResult(
      result.items.map(toAuditLogDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  @AdminResponseContract(auditLogAuditLogDtoArrayContract)
  @Get('entity/:entityType/:entityId')
  async getEntityHistory(
    @Req() req: Request,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogAuditLogDtoDto[]> {
    // ADMIN-MEDIUM-003: meta-audit
    await this.writeMetaAudit(req, 'ENTITY_HISTORY', { entityType, entityId });
    return (
      await this.auditLogService.getEntityHistory(
        entityType,
        entityId,
        limit ? parseInt(limit, 10) : 100,
      )
    ).map(toAuditLogDto);
  }

  @AdminResponseContract(auditLogAuditLogDtoArrayContract)
  @Get('user/:userId')
  async getUserActivity(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogAuditLogDtoDto[]> {
    // ADMIN-MEDIUM-003: meta-audit
    await this.writeMetaAudit(req, 'USER_ACTIVITY', { targetUserId: userId });
    return (
      await this.auditLogService.getUserActivity(
        userId,
        parseAuditDateBoundary(startDate, 'startDate'),
        parseAuditDateBoundary(endDate, 'endDate'),
        limit ? parseInt(limit, 10) : 100,
      )
    ).map(toAuditLogDto);
  }

  @AdminResponseContract(auditLogAuditLogDtoArrayContract)
  @Get('security')
  async getSecurityLogs(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogAuditLogDtoDto[]> {
    // ADMIN-MEDIUM-003: meta-audit -- security log access is especially sensitive
    await this.writeMetaAudit(req, 'SECURITY_LOGS', { tenantId });
    return (
      await this.auditLogService.getSecurityLogs(tenantId, limit ? parseInt(limit, 10) : 100)
    ).map(toAuditLogDto);
  }

  @AdminResponseContract(auditLogAuditStatisticsDtoContract)
  @Get('statistics')
  async getStatistics(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<AuditLogAuditStatisticsDtoDto> {
    await this.writeMetaAudit(req, 'STATISTICS', { tenantId, startDate, endDate });
    return this.auditLogService.getStatistics(
      tenantId,
      parseAuditDateBoundary(startDate, 'startDate'),
      parseAuditDateBoundary(endDate, 'endDate'),
    );
  }

  @AdminManualResponse(auditLogExportProfile)
  @ThrottleExport()
  @Post('export')
  async exportAuditLogs(
    @Req() req: Request,
    @Body() body: ExportAuditLogsDto,
    @Res() res: Response,
  ): Promise<void> {
    const action = this.parseAction(body.action);
    const severity = this.parseSeverity(body.severity);
    const cutAt = parseAuditDateBoundary(body.endDate, 'endDate') ?? new Date();
    const filter: AuditLogFilter = {
      action,
      entityType: body.entityType,
      entityId: body.entityId,
      tenantId: body.tenantId,
      performedBy: body.performedBy,
      severity,
      startDate: parseAuditDateBoundary(body.startDate, 'startDate'),
      endDate: cutAt,
      search: body.search,
    };

    // Persist intent first. A failed evidence append prevents both the source
    // query and the binary disclosure.
    await this.writeMetaAudit(req, 'EXPORT', {
      filter: {
        action,
        entityType: body.entityType,
        tenantId: body.tenantId,
        severity,
      },
      cutAt: cutAt.toISOString(),
    });

    const rows = await this.auditLogService.getExportRows(filter);
    const headers = [
      'id',
      'createdAt',
      'action',
      'severity',
      'trustClass',
      'entityType',
      'entityId',
      'tenantId',
      'performedBy',
      'performedByEmail',
      'ipAddress',
      'legacySourceAuthority',
      'legacySourceRowId',
      'legacySourceRowSha256',
    ];
    const csv = [
      headers.map(auditCsvCell).join(','),
      ...rows.map((row) =>
        [
          row.id,
          row.createdAt.toISOString(),
          row.action,
          row.severity,
          row.trustClass,
          row.entityType,
          row.entityId,
          row.tenantId,
          row.performedBy,
          row.performedByEmail,
          row.ipAddress,
          row.provenance?.sourceAuthority,
          row.provenance?.sourceRowId,
          row.provenance?.sourceRowSha256,
        ]
          .map(auditCsvCell)
          .join(','),
      ),
    ].join('\n');

    sendAdminBinaryResponse(res, auditLogExportProfile, {
      status: HttpStatus.OK,
      mediaType: 'text/csv',
      filename: createAdminAttachmentFilename(
        `admin-audit-${cutAt.toISOString().replace(/[:.]/gu, '-')}.csv`,
      ),
      data: csv,
    });
  }

  private parseAction(value: string | undefined): AdminAuditAction | undefined {
    if (value === undefined) return undefined;
    if (!isAdminAuditAction(value)) {
      throw new BadRequestException('action is not part of the admin audit vocabulary');
    }
    return value;
  }

  private parseSeverity(value: string | undefined): AuditSeverity | undefined {
    if (value === undefined) return undefined;
    if (!isAdminAuditSeverity(value)) {
      throw new BadRequestException('severity is not part of the admin audit vocabulary');
    }
    return value;
  }
}
