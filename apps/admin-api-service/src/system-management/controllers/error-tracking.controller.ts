import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

import { IsString, IsOptional, IsObject, IsArray, IsNumber, IsBoolean, IsUUID, IsIn, MaxLength, ArrayMaxSize } from 'class-validator';

import { ErrorGroup, ErrorSeverity, ErrorStatus, ErrorContext } from '../entities/error-tracking.entity';
import { ErrorTrackingService, ErrorReport } from '../services/error-tracking.service';
import { ERROR_GROUP_SORT_FIELDS, ErrorGroupSortField } from '../sorting/error-group-sort';

// ============================================================================
// DTOs
// ============================================================================

export class QueryErrorGroupsDto {
  @IsOptional()
  @IsString()
  status?: ErrorStatus;

  @IsOptional()
  @IsString()
  severity?: ErrorSeverity;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isRegression?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsIn(ERROR_GROUP_SORT_FIELDS)
  sortBy?: ErrorGroupSortField;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

class ReportErrorDto {
  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  errorType?: string;

  @IsOptional()
  @IsString()
  stackTrace?: string;

  @IsOptional()
  @IsString()
  severity?: ErrorSeverity;

  @IsOptional()
  @IsObject()
  context?: ErrorContext;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  environment?: string;

  @IsOptional()
  @IsString()
  release?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class UpdateErrorGroupDto {
  @IsOptional()
  @IsString()
  status?: ErrorStatus;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  linkedTicketUrl?: string;
}

class ResolveErrorGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

class AssignErrorGroupDto {
  @IsString()
  @MaxLength(255)
  assigneeId!: string;
}

class MergeErrorGroupsDto {
  @IsString()
  targetId!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  sourceIds!: string[];
}

class UpdateErrorAlertRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsObject()
  conditions?: {
    severity?: ErrorSeverity[];
    service?: string[];
    errorType?: string[];
    messagePattern?: string;
    occurrenceThreshold?: number;
    timeWindowMinutes?: number;
    userCountThreshold?: number;
  };

  @IsOptional()
  @IsArray()
  actions?: Array<{
    type: 'email' | 'slack' | 'pagerduty' | 'webhook' | 'sms';
    config: Record<string, unknown>;
  }>;

  @IsOptional()
  @IsNumber()
  cooldownMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class CreateAlertRuleDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsObject()
  conditions!: {
    severity?: ErrorSeverity[];
    service?: string[];
    errorType?: string[];
    messagePattern?: string;
    occurrenceThreshold?: number;
    timeWindowMinutes?: number;
    userCountThreshold?: number;
  };

  @IsArray()
  actions!: Array<{
    type: 'email' | 'slack' | 'pagerduty' | 'webhook' | 'sms';
    config: Record<string, unknown>;
  }>;

  @IsOptional()
  @IsNumber()
  cooldownMinutes?: number;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Analytics')
@Controller('system/errors')
export class ErrorTrackingController {
  constructor(private readonly errorTrackingService: ErrorTrackingService) {}

  // ============================================================================
  // Dashboard
  // ============================================================================

  @Get('dashboard')
  async getErrorDashboard(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.errorTrackingService.getErrorDashboard({
      service,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    });
  }

  @Get('stats')
  async getErrorStats(
    @Query('groupBy') groupBy: 'service' | 'errorType' | 'severity' | 'tenant',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.errorTrackingService.getErrorStats({
      groupBy,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    });
  }

  // ============================================================================
  // Error Reporting
  // ============================================================================

  @Post('report')
  async reportError(@Body() dto: ReportErrorDto) {
    return this.errorTrackingService.reportError(dto);
  }

  // ============================================================================
  // Error Groups
  // ============================================================================

  @Get('groups')
  async queryErrorGroups(
    @Query() query: QueryErrorGroupsDto,
  ): Promise<{ items: ErrorGroup[]; total: number }> {
    return this.errorTrackingService.queryErrorGroups({
      status: query.status,
      severity: query.severity,
      service: query.service,
      search: query.search,
      assignedTo: query.assignedTo,
      isRegression: query.isRegression,
      page: query.page,
      limit: query.limit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('groups/:id')
  async getErrorGroup(@Param('id') id: string) {
    return this.errorTrackingService.getErrorGroup(id);
  }

  @Put('groups/:id')
  async updateErrorGroup(@Param('id') id: string, @Body() dto: UpdateErrorGroupDto) {
    let result = await this.errorTrackingService.getErrorGroup(id);

    if (dto.status) {
      result = await this.errorTrackingService.updateErrorGroupStatus(id, dto.status);
    }
    if (dto.assignedTo) {
      result = await this.errorTrackingService.assignErrorGroup(id, dto.assignedTo);
    }
    if (dto.notes) {
      result = await this.errorTrackingService.addNoteToErrorGroup(id, dto.notes);
    }
    if (dto.linkedTicketUrl) {
      result = await this.errorTrackingService.linkTicket(id, dto.linkedTicketUrl);
    }

    return result;
  }

  @Post('groups/:id/resolve')
  async resolveErrorGroup(
    @Param('id') id: string,
    @Body() dto: ResolveErrorGroupDto,
  ) {
    return this.errorTrackingService.updateErrorGroupStatus(
      id,
      ErrorStatus.RESOLVED,
      dto.userId,
      dto.notes,
    );
  }

  @Post('groups/:id/acknowledge')
  async acknowledgeErrorGroup(@Param('id') id: string) {
    return this.errorTrackingService.updateErrorGroupStatus(id, ErrorStatus.ACKNOWLEDGED);
  }

  @Post('groups/:id/ignore')
  async ignoreErrorGroup(@Param('id') id: string) {
    return this.errorTrackingService.updateErrorGroupStatus(id, ErrorStatus.IGNORED);
  }

  @Post('groups/:id/assign')
  async assignErrorGroup(
    @Param('id') id: string,
    @Body() dto: AssignErrorGroupDto,
  ) {
    return this.errorTrackingService.assignErrorGroup(id, dto.assigneeId);
  }

  @Post('groups/merge')
  async mergeErrorGroups(
    @Body() dto: MergeErrorGroupsDto,
  ) {
    return this.errorTrackingService.mergeErrorGroups(dto.targetId, dto.sourceIds);
  }

  // ============================================================================
  // Error Occurrences
  // ============================================================================

  @Get('occurrences')
  async queryOccurrences(
    @Query('service') service?: string,
    @Query('severity') severity?: ErrorSeverity,
    @Query('tenantId') tenantId?: string,
    @Query('userId') userId?: string,
    @Query('environment') environment?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.errorTrackingService.queryOccurrences({
      service,
      severity,
      tenantId,
      userId,
      environment,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('occurrences/:id')
  async getErrorOccurrence(@Param('id') id: string) {
    return this.errorTrackingService.getErrorOccurrence(id);
  }

  @Get('groups/:groupId/occurrences')
  async getOccurrencesForGroup(
    @Param('groupId') groupId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.errorTrackingService.getOccurrencesForGroup(groupId, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================================
  // Alert Rules
  // ============================================================================

  @Post('alert-rules')
  async createAlertRule(@Body() dto: CreateAlertRuleDto) {
    return this.errorTrackingService.createAlertRule(dto);
  }

  @Get('alert-rules')
  async getAlertRules() {
    return this.errorTrackingService.getAlertRules();
  }

  @Put('alert-rules/:id')
  async updateAlertRule(
    @Param('id') id: string,
    @Body() dto: UpdateErrorAlertRuleDto,
  ) {
    return this.errorTrackingService.updateAlertRule(id, dto);
  }

  @Delete('alert-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAlertRule(@Param('id') id: string) {
    await this.errorTrackingService.deleteAlertRule(id);
  }
}
