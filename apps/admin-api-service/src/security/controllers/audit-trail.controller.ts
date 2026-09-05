/**
 * Audit Trail Controller
 *
 * Endpoints for audit trail queries, export, retention policies, and alerts.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Query,
  Param,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsOptional,
  IsNumber,
  IsString,
  IsBoolean,
  IsIn,
  IsArray,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { Request, Response } from 'express';

import { AuditLog, AuditSeverity as ImmutableAuditSeverity } from '../../audit/audit.entity';
import { AuditLogFilter, AuditLogService, PaginatedAuditLogs } from '../../audit/audit.service';
import { getAuthUser } from '../../shared/authenticated-request';
import { listRetentionPolicies } from '@aquaculture/backend-common/database';

import { ActivityCategory, ActivitySeverity } from '../entities/security.entity';
import {
  AuditTrailService,
  AuditExportOptions,
  AuditAlertRule,
  RetentionStats,
} from '../services/audit-trail.service';
import { ACTIVITY_LOG_SORT_FIELDS, ActivityLogSortField } from '../sorting/activity-log-sort';

// ============================================================================
// DTOs
// ============================================================================

export class QueryAuditTrailDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  performedBy?: string;

  @IsOptional()
  @IsString()
  userEmail?: string;

  @IsOptional()
  @IsIn([
    'user_action',
    'system_event',
    'api_call',
    'data_access',
    'security_event',
    'configuration',
    'authentication',
  ])
  category?: ActivityCategory;

  @IsOptional()
  @IsString()
  severity?: string; // Comma-separated

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  actions?: string; // Comma-separated

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  success?: boolean;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  searchQuery?: string;

  @IsOptional()
  @IsString()
  tags?: string; // Comma-separated

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeArchived?: boolean;

  @IsOptional()
  @IsIn(ACTIVITY_LOG_SORT_FIELDS)
  sortBy?: ActivityLogSortField;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

class ExportAuditTrailDto {
  @IsIn(['csv', 'json', 'pdf'])
  format!: 'csv' | 'json' | 'pdf';

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  category?: ActivityCategory;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;

  @IsOptional()
  @IsBoolean()
  includeMetadata?: boolean;

  @IsOptional()
  @IsBoolean()
  includeChanges?: boolean;
}

class CreateAlertRuleDto {
  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @IsBoolean()
  isActive!: boolean;

  @IsObject()
  conditions!: {
    category?: ActivityCategory[];
    severity?: ActivitySeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };

  @IsArray()
  alertChannels!: ('email' | 'webhook' | 'slack' | 'sms')[];

  @IsArray()
  recipients!: string[];

  @IsNumber()
  cooldownMinutes!: number;
}

class UpdateAuditAlertRuleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  conditions?: {
    category?: ActivityCategory[];
    severity?: ActivitySeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };

  @IsOptional()
  @IsArray()
  alertChannels?: ('email' | 'webhook' | 'slack' | 'sms')[];

  @IsOptional()
  @IsArray()
  recipients?: string[];

  @IsOptional()
  @IsNumber()
  cooldownMinutes?: number;
}

// ============================================================================
// Controller
// ============================================================================

export interface RetentionPolicyView {
  id: string;
  ownerTag: string;
  schema: string;
  tableName: string;
  timestampColumn: string;
  retentionDays: number;
  legalHoldAware: boolean;
}

@ApiTags('Security')
@Controller('security/audit')
export class AuditTrailController {
  constructor(
    private readonly auditService: AuditTrailService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private writeMetaAudit(req: Request, action: string, details: Record<string, unknown>): void {
    const user = getAuthUser(req);
    const userAgentHeader = req.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader.join(',') : userAgentHeader;

    void this.auditLogService
      .log({
        action: 'AUDIT_LOG_ACCESSED',
        entityType: 'AuditLog',
        performedBy: user?.id ?? 'unknown',
        performedByEmail: user?.email,
        ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
        userAgent,
        details: { subAction: action, ...details },
        severity: ImmutableAuditSeverity.INFO,
      })
      .catch(() => {
        // Meta-audit failure must not block the primary immutable audit read.
      });
  }

  /**
   * Query audit trail
   */
  @Get()
  async queryAuditTrail(
    @Req() req: Request,
    @Query() query: QueryAuditTrailDto,
  ): Promise<PaginatedAuditLogs> {
    const action = query.action ?? query.actions?.split(',')[0];
    const severity = query.severity?.split(',')[0] as ImmutableAuditSeverity | undefined;
    const filter: AuditLogFilter = {
      action,
      entityType: query.entityType,
      entityId: query.entityId,
      tenantId: query.tenantId,
      performedBy: query.performedBy ?? query.userId,
      performedByEmail: query.userEmail,
      severity,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      search: query.search ?? query.searchQuery,
    };

    this.writeMetaAudit(req, 'SECURITY_AUDIT_QUERY', {
      action,
      entityType: query.entityType,
      tenantId: query.tenantId,
      severity,
    });

    return this.auditLogService.query(
      filter,
      query.page ? parseInt(String(query.page), 10) : 1,
      query.limit ? parseInt(String(query.limit), 10) : 50,
    );
  }

  /**
   * Get immutable audit trail for one entity
   */
  @Get('entity/:entityType/:entityId')
  async getEntityAuditTrail(
    @Req() req: Request,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    this.writeMetaAudit(req, 'SECURITY_AUDIT_ENTITY', { entityType, entityId });

    return this.auditLogService.getEntityHistory(
      entityType,
      entityId,
      limit ? parseInt(limit, 10) : 100,
    );
  }

  /**
   * Get audit summary
   */
  @Get('summary')
  async getAuditSummary(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{
    totalLogs: number;
    last24Hours: number;
    byAction: Array<{ action: string; count: number }>;
    bySeverity: Array<{ severity: string; count: number }>;
    byEntityType: Array<{ entityType: string; count: number }>;
    topUsers: Array<{ userId: string; email: string; count: number }>;
  }> {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    this.writeMetaAudit(req, 'SECURITY_AUDIT_SUMMARY', { tenantId });

    return this.auditLogService.getStatistics(tenantId, start, end);
  }

  /**
   * Export audit trail
   */
  @Post('export')
  async exportAuditTrail(@Body() dto: ExportAuditTrailDto, @Res() res: Response): Promise<void> {
    const options: AuditExportOptions = {
      format: dto.format,
      tenantId: dto.tenantId,
      userId: dto.userId,
      category: dto.category,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
      includeMetadata: dto.includeMetadata,
      includeChanges: dto.includeChanges,
    };

    const result = await this.auditService.exportAuditTrail(options);

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.data);
  }

  // ============================================================================
  // Retention Policies — READ-ONLY view of the build-time registry (ADR-0012)
  // ============================================================================

  /**
   * The retention windows in force, straight from the kernel registry.
   * Windows are compliance commitments declared in code
   * (AdminApiRetentionBootstrapModule) and enforced by the single platform
   * enforcer; there is no runtime editor and no per-policy "apply".
   */
  @Get('retention-policies')
  getRetentionPolicies(): RetentionPolicyView[] {
    return listRetentionPolicies().map((policy) => ({
      id: policy.id,
      ownerTag: policy.ownerTag,
      schema: policy.schema,
      tableName: policy.tableName,
      timestampColumn: policy.timestampColumn,
      retentionDays: policy.retentionDays,
      legalHoldAware: policy.legalHoldAware,
    }));
  }

  /**
   * Get retention statistics
   */
  @Get('retention-stats')
  async getRetentionStats(): Promise<RetentionStats> {
    return this.auditService.getRetentionStats();
  }

  // ============================================================================
  // Alert Rules
  // ============================================================================

  /**
   * Get all alert rules
   */
  @Get('alert-rules')
  getAlertRules(): AuditAlertRule[] {
    return this.auditService.getAlertRules();
  }

  /**
   * Create alert rule
   */
  @Post('alert-rules')
  @HttpCode(HttpStatus.CREATED)
  createAlertRule(@Body() dto: CreateAlertRuleDto): AuditAlertRule {
    return this.auditService.createAlertRule(dto);
  }

  /**
   * Update alert rule
   */
  @Put('alert-rules/:id')
  updateAlertRule(
    @Param('id') id: string,
    @Body() dto: UpdateAuditAlertRuleDto,
  ): AuditAlertRule | null {
    return this.auditService.updateAlertRule(id, dto);
  }

  /**
   * Delete alert rule
   */
  @Delete('alert-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteAlertRule(@Param('id') id: string): void {
    this.auditService.deleteAlertRule(id);
  }
}
