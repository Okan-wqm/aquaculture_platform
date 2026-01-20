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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { IsOptional, IsNumber, IsString, IsBoolean, IsIn, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  AuditTrailService,
  AuditExportOptions,
  AuditAlertRule,
  AuditSummary,
  RetentionStats,
} from '../services/audit-trail.service';
import { ActivityLog, ActivityCategory, ActivitySeverity, RetentionPolicyEntity, ComplianceType } from '../entities/security.entity';

// ============================================================================
// DTOs
// ============================================================================

class QueryAuditTrailDto {
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
  userEmail?: string;

  @IsOptional()
  @IsIn(['user_action', 'system_event', 'api_call', 'data_access', 'security_event', 'configuration', 'authentication'])
  category?: ActivityCategory;

  @IsOptional()
  @IsString()
  severity?: string; // Comma-separated

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
  searchQuery?: string;

  @IsOptional()
  @IsString()
  tags?: string; // Comma-separated

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeArchived?: boolean;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

class ExportAuditTrailDto {
  format: 'csv' | 'json' | 'pdf';
  tenantId?: string;
  userId?: string;
  category?: ActivityCategory;
  startDate: string;
  endDate: string;
  includeMetadata?: boolean;
  includeChanges?: boolean;
}

class CreateRetentionPolicyDto {
  name: string;
  category: ActivityCategory;
  description?: string;
  retentionDays: number;
  archiveAfterDays?: number;
  deleteAfterArchiveDays?: number;
  isGlobal?: boolean;
  specificTenants?: string[];
  complianceFrameworks?: ComplianceType[];
}

class UpdateRetentionPolicyDto {
  name?: string;
  description?: string;
  retentionDays?: number;
  archiveAfterDays?: number;
  deleteAfterArchiveDays?: number;
  isGlobal?: boolean;
  specificTenants?: string[];
  complianceFrameworks?: ComplianceType[];
  isActive?: boolean;
}

class CreateAlertRuleDto {
  name: string;
  description: string;
  isActive: boolean;
  conditions: {
    category?: ActivityCategory[];
    severity?: ActivitySeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };
  alertChannels: ('email' | 'webhook' | 'slack' | 'sms')[];
  recipients: string[];
  cooldownMinutes: number;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('security/audit')
export class AuditTrailController {
  constructor(private readonly auditService: AuditTrailService) {}

  /**
   * Query audit trail
   */
  @Get()
  async queryAuditTrail(
    @Query() query: QueryAuditTrailDto,
  ): Promise<{
    data: ActivityLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.auditService.getAuditTrail({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 50,
      tenantId: query.tenantId,
      userId: query.userId,
      userEmail: query.userEmail,
      category: query.category,
      severity: query.severity?.split(',') as ActivitySeverity[],
      actions: query.actions?.split(','),
      entityType: query.entityType,
      entityId: query.entityId,
      ipAddress: query.ipAddress,
      success: query.success !== undefined ? query.success === true || query.success === 'true' as unknown as boolean : undefined,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      searchQuery: query.searchQuery,
      tags: query.tags?.split(','),
      includeArchived: query.includeArchived === true || query.includeArchived === 'true' as unknown as boolean,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  /**
   * Get audit summary
   */
  @Get('summary')
  async getAuditSummary(
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<AuditSummary> {
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    return this.auditService.getAuditSummary({
      tenantId,
      startDate: start,
      endDate: end,
    });
  }

  /**
   * Export audit trail
   */
  @Post('export')
  async exportAuditTrail(
    @Body() dto: ExportAuditTrailDto,
    @Res() res: Response,
  ): Promise<void> {
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
  // Retention Policies
  // ============================================================================

  /**
   * Get all retention policies
   */
  @Get('retention-policies')
  async getRetentionPolicies(): Promise<RetentionPolicyEntity[]> {
    return this.auditService.getRetentionPolicies();
  }

  /**
   * Get retention policy by ID
   */
  @Get('retention-policies/:id')
  async getRetentionPolicy(@Param('id') id: string): Promise<RetentionPolicyEntity> {
    return this.auditService.getRetentionPolicy(id);
  }

  /**
   * Create retention policy
   */
  @Post('retention-policies')
  @HttpCode(HttpStatus.CREATED)
  async createRetentionPolicy(
    @Body() dto: CreateRetentionPolicyDto,
  ): Promise<RetentionPolicyEntity> {
    return this.auditService.createRetentionPolicy({
      ...dto,
      createdBy: 'admin', // Would come from auth context
    });
  }

  /**
   * Update retention policy
   */
  @Put('retention-policies/:id')
  async updateRetentionPolicy(
    @Param('id') id: string,
    @Body() dto: UpdateRetentionPolicyDto,
  ): Promise<RetentionPolicyEntity> {
    return this.auditService.updateRetentionPolicy(id, dto, 'admin');
  }

  /**
   * Delete retention policy
   */
  @Delete('retention-policies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRetentionPolicy(@Param('id') id: string): Promise<void> {
    await this.auditService.deleteRetentionPolicy(id);
  }

  /**
   * Get retention statistics
   */
  @Get('retention-stats')
  async getRetentionStats(): Promise<RetentionStats> {
    return this.auditService.getRetentionStats();
  }

  /**
   * Apply retention policies manually
   */
  @Post('retention-policies/apply')
  @HttpCode(HttpStatus.OK)
  async applyRetentionPolicies(): Promise<{ success: boolean }> {
    await this.auditService.applyRetentionPolicies();
    return { success: true };
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
    @Body() dto: Partial<CreateAlertRuleDto>,
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
