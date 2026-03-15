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
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsObject, IsArray, IsNumber } from 'class-validator';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';

import { ErrorSeverity, ErrorStatus, ErrorContext } from '../entities/error-tracking.entity';
import { ErrorTrackingService, ErrorReport } from '../services/error-tracking.service';

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
@UseGuards(PlatformAdminGuard) // H14 fix: explicit guard
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
    @Query('status') status?: ErrorStatus,
    @Query('severity') severity?: ErrorSeverity,
    @Query('service') service?: string,
    @Query('search') search?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('isRegression') isRegression?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('sortBy') sortBy?: 'occurrenceCount' | 'lastSeenAt' | 'firstSeenAt' | 'userCount',
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
  ) {
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
    @Body() dto: { userId?: string; notes?: string },
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
    @Body() dto: { assigneeId: string },
  ) {
    return this.errorTrackingService.assignErrorGroup(id, dto.assigneeId);
  }

  @Post('groups/merge')
  async mergeErrorGroups(
    @Body() dto: { targetId: string; sourceIds: string[] },
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
    @Body() dto: Partial<CreateAlertRuleDto> & { isActive?: boolean },
  ) {
    return this.errorTrackingService.updateAlertRule(id, dto);
  }

  @Delete('alert-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAlertRule(@Param('id') id: string) {
    await this.errorTrackingService.deleteAlertRule(id);
  }
}
