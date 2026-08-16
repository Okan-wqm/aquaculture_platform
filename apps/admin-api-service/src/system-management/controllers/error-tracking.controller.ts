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
import type { AdminSqlIdentifierKey } from '@platform/admin-http-contracts';

import {
  IsString,
  IsOptional,
  IsObject,
  IsArray,
  IsNumber,
  IsBoolean,
  IsUUID,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

import { ErrorSeverity, ErrorStatus, ErrorContext } from '../entities/error-tracking.entity';
import { ErrorTrackingService, ErrorReport } from '../services/error-tracking.service';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  errorTrackingErrorDashboardContract,
  type ErrorTrackingErrorDashboardDto,
  errorTrackingGetErrorStatsResponseArrayContract,
  type ErrorTrackingGetErrorStatsResponseDto,
  errorTrackingErrorOccurrenceContract,
  type ErrorTrackingErrorOccurrenceDto,
  errorTrackingQueryErrorGroupsResponseContract,
  type ErrorTrackingQueryErrorGroupsResponseDto,
  errorTrackingErrorGroupContract,
  type ErrorTrackingErrorGroupDto,
  errorTrackingQueryOccurrencesResponseContract,
  type ErrorTrackingQueryOccurrencesResponseDto,
  errorTrackingGetOccurrencesForGroupResponseContract,
  type ErrorTrackingGetOccurrencesForGroupResponseDto,
  errorTrackingErrorAlertRuleContract,
  type ErrorTrackingErrorAlertRuleDto,
  errorTrackingErrorAlertRuleArrayContract,
  voidResponseContract,
  type VoidResponseDto,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs
// ============================================================================

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

  @AdminResponseContract(errorTrackingErrorDashboardContract)
  @Get('dashboard')
  async getErrorDashboard(
    @Query('service') service?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<ErrorTrackingErrorDashboardDto> {
    return this.errorTrackingService.getErrorDashboard({
      service,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    });
  }

  @AdminResponseContract(errorTrackingGetErrorStatsResponseArrayContract)
  @Get('stats')
  async getErrorStats(
    @Query('groupBy') groupBy: 'service' | 'errorType' | 'severity' | 'tenant',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<ErrorTrackingGetErrorStatsResponseDto[]> {
    return this.errorTrackingService.getErrorStats({
      groupBy,
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    });
  }

  // ============================================================================
  // Error Reporting
  // ============================================================================

  @AdminResponseContract(errorTrackingErrorOccurrenceContract)
  @Post('report')
  async reportError(@Body() dto: ReportErrorDto): Promise<ErrorTrackingErrorOccurrenceDto> {
    return this.errorTrackingService.reportError(dto);
  }

  // ============================================================================
  // Error Groups
  // ============================================================================

  @AdminResponseContract(errorTrackingQueryErrorGroupsResponseContract)
  @Get('groups')
  async queryErrorGroups(
    @Query('status') status?: ErrorStatus,
    @Query('severity') severity?: ErrorSeverity,
    @Query('service') service?: string,
    @Query('search') search?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('isRegression') isRegression?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('sortBy') sortBy?: AdminSqlIdentifierKey<'GET /system/errors/groups'>,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
  ): Promise<ErrorTrackingQueryErrorGroupsResponseDto> {
    return this.errorTrackingService.queryErrorGroups({
      status,
      severity,
      service,
      search,
      assignedTo,
      isRegression: isRegression !== undefined ? isRegression === 'true' : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortOrder,
    });
  }

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Get('groups/:id')
  async getErrorGroup(@Param('id') id: string): Promise<ErrorTrackingErrorGroupDto> {
    return this.errorTrackingService.getErrorGroup(id);
  }

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Put('groups/:id')
  async updateErrorGroup(
    @Param('id') id: string,
    @Body() dto: UpdateErrorGroupDto,
  ): Promise<ErrorTrackingErrorGroupDto> {
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

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Post('groups/:id/resolve')
  async resolveErrorGroup(
    @Param('id') id: string,
    @Body() dto: ResolveErrorGroupDto,
  ): Promise<ErrorTrackingErrorGroupDto> {
    return this.errorTrackingService.updateErrorGroupStatus(
      id,
      ErrorStatus.RESOLVED,
      dto.userId,
      dto.notes,
    );
  }

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Post('groups/:id/acknowledge')
  async acknowledgeErrorGroup(@Param('id') id: string): Promise<ErrorTrackingErrorGroupDto> {
    return this.errorTrackingService.updateErrorGroupStatus(id, ErrorStatus.ACKNOWLEDGED);
  }

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Post('groups/:id/ignore')
  async ignoreErrorGroup(@Param('id') id: string): Promise<ErrorTrackingErrorGroupDto> {
    return this.errorTrackingService.updateErrorGroupStatus(id, ErrorStatus.IGNORED);
  }

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Post('groups/:id/assign')
  async assignErrorGroup(
    @Param('id') id: string,
    @Body() dto: AssignErrorGroupDto,
  ): Promise<ErrorTrackingErrorGroupDto> {
    return this.errorTrackingService.assignErrorGroup(id, dto.assigneeId);
  }

  @AdminResponseContract(errorTrackingErrorGroupContract)
  @Post('groups/merge')
  async mergeErrorGroups(@Body() dto: MergeErrorGroupsDto): Promise<ErrorTrackingErrorGroupDto> {
    return this.errorTrackingService.mergeErrorGroups(dto.targetId, dto.sourceIds);
  }

  // ============================================================================
  // Error Occurrences
  // ============================================================================

  @AdminResponseContract(errorTrackingQueryOccurrencesResponseContract)
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
  ): Promise<ErrorTrackingQueryOccurrencesResponseDto> {
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

  @AdminResponseContract(errorTrackingErrorOccurrenceContract)
  @Get('occurrences/:id')
  async getErrorOccurrence(@Param('id') id: string): Promise<ErrorTrackingErrorOccurrenceDto> {
    return this.errorTrackingService.getErrorOccurrence(id);
  }

  @AdminResponseContract(errorTrackingGetOccurrencesForGroupResponseContract)
  @Get('groups/:groupId/occurrences')
  async getOccurrencesForGroup(
    @Param('groupId') groupId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<ErrorTrackingGetOccurrencesForGroupResponseDto> {
    return this.errorTrackingService.getOccurrencesForGroup(groupId, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================================
  // Alert Rules
  // ============================================================================

  @AdminResponseContract(errorTrackingErrorAlertRuleContract)
  @Post('alert-rules')
  async createAlertRule(@Body() dto: CreateAlertRuleDto): Promise<ErrorTrackingErrorAlertRuleDto> {
    return this.errorTrackingService.createAlertRule(dto);
  }

  @AdminResponseContract(errorTrackingErrorAlertRuleArrayContract)
  @Get('alert-rules')
  async getAlertRules(): Promise<ErrorTrackingErrorAlertRuleDto[]> {
    return this.errorTrackingService.getAlertRules();
  }

  @AdminResponseContract(errorTrackingErrorAlertRuleContract)
  @Put('alert-rules/:id')
  async updateAlertRule(
    @Param('id') id: string,
    @Body() dto: UpdateErrorAlertRuleDto,
  ): Promise<ErrorTrackingErrorAlertRuleDto> {
    return this.errorTrackingService.updateAlertRule(id, dto);
  }

  @AdminResponseContract(voidResponseContract)
  @Delete('alert-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAlertRule(@Param('id') id: string): Promise<void> {
    await this.errorTrackingService.deleteAlertRule(id);
  }
}
