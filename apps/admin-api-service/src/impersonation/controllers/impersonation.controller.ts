import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsEnum,
  IsInt,
  IsArray,
  IsObject,
  Min,
  Max,
  MaxLength,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';

import {
  ImpersonationService,
  StartImpersonationRequest,
} from '../services/impersonation.service';
import {
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
} from '../entities/impersonation-session.entity';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';

// ============================================================================
// DTOs with Validation
// ============================================================================

class GrantPermissionDto {
  @IsUUID('4', { message: 'Invalid super admin ID format' })
  superAdminId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  superAdminEmail?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  allowedTenants?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  restrictedTenants?: string[];

  @IsOptional()
  @IsObject()
  defaultPermissions?: ImpersonationPermissions;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440) // Max 24 hours
  maxSessionDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsBoolean()
  requireReason?: boolean;

  @IsOptional()
  @IsBoolean()
  requireTicketReference?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyTenantAdmin?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

class StartImpersonationDto {
  @IsUUID('4', { message: 'Invalid target tenant ID format' })
  targetTenantId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetTenantName?: string;

  @IsOptional()
  @IsUUID('4')
  targetUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetUserEmail?: string;

  @IsEnum(ImpersonationReason, { message: 'Invalid impersonation reason' })
  reason: ImpersonationReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reasonDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticketReference?: string;

  @IsOptional()
  @IsObject()
  permissions?: Partial<ImpersonationPermissions>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480) // Max 8 hours
  durationMinutes?: number;
}

class LogActionDto {
  @IsString()
  @MaxLength(100)
  action: string;

  @IsString()
  @MaxLength(100)
  resource: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;

  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

class QueryPermissionsDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsString()
  isActive?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class QuerySessionsDto {
  @IsOptional()
  @IsUUID('4')
  superAdminId?: string;

  @IsOptional()
  @IsUUID('4')
  targetTenantId?: string;

  @IsOptional()
  @IsEnum(ImpersonationStatus)
  status?: ImpersonationStatus;

  @IsOptional()
  @IsEnum(ImpersonationReason)
  reason?: ImpersonationReason;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('impersonation')
@UseGuards(PlatformAdminGuard)
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  // ============================================================================
  // Permission Management
  // ============================================================================

  @Get('permissions')
  async queryPermissions(@Query() query: QueryPermissionsDto) {
    return this.impersonationService.queryPermissions({
      tenantId: query.tenantId,
      isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('stats')
  async getStats() {
    return this.impersonationService.getImpersonationStats();
  }

  @Post('permissions')
  async grantPermission(
    @Body() dto: GrantPermissionDto,
    @Req() req: Request,
  ) {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = (req as any).user;
    if (!user?.id) {
      throw new Error('User not authenticated');
    }
    return this.impersonationService.grantImpersonationPermission({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      grantedBy: user.id,
    });
  }

  @Get('permissions/:superAdminId')
  async getPermission(@Param('superAdminId') superAdminId: string) {
    return this.impersonationService.getImpersonationPermission(superAdminId);
  }

  @Post('permissions/:superAdminId/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokePermission(@Param('superAdminId') superAdminId: string) {
    await this.impersonationService.revokeImpersonationPermission(superAdminId);
  }

  @Get('permissions/:superAdminId/check/:tenantId')
  async checkPermission(
    @Param('superAdminId') superAdminId: string,
    @Param('tenantId') tenantId: string,
  ) {
    return this.impersonationService.canImpersonate(superAdminId, tenantId);
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  @Post('sessions/start')
  async startImpersonation(
    @Body() dto: StartImpersonationDto,
    @Req() req: Request,
  ) {
    // SECURITY FIX: Get admin identity from verified JWT token, not client-supplied headers
    const user = (req as any).user;
    if (!user?.id || !user?.email) {
      throw new Error('User not authenticated');
    }
    const request: StartImpersonationRequest = {
      superAdminId: user.id,
      superAdminEmail: user.email,
      ...dto,
      ipAddress: (req.ip || req.socket.remoteAddress) ?? undefined,
      userAgent: req.headers['user-agent'],
    };

    return this.impersonationService.startImpersonation(request);
  }

  @Post('sessions/:id/end')
  async endImpersonation(
    @Param('id') sessionId: string,
    @Body() dto: { reason?: string },
    @Req() req: Request,
  ) {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = (req as any).user;
    if (!user?.id) {
      throw new Error('User not authenticated');
    }
    return this.impersonationService.endImpersonation(sessionId, dto.reason, user.id);
  }

  @Post('sessions/:id/terminate')
  async terminateSession(
    @Param('id') sessionId: string,
    @Body() dto: { reason: string },
    @Req() req: Request,
  ) {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = (req as any).user;
    if (!user?.id) {
      throw new Error('User not authenticated');
    }
    return this.impersonationService.terminateSession(sessionId, user.id, dto.reason);
  }

  @Get('sessions/validate')
  async validateSession(@Headers('x-impersonation-token') token: string) {
    const context = await this.impersonationService.validateSession(token);
    return { valid: !!context, context };
  }

  @Get('sessions/active')
  async getActiveSessions() {
    return this.impersonationService.getActiveSessions();
  }

  @Get('sessions/active/count')
  async getActiveSessionCount() {
    return { count: this.impersonationService.getActiveSessionCount() };
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string) {
    return this.impersonationService.getSession(id);
  }

  @Get('sessions')
  async querySessions(@Query() query: QuerySessionsDto) {
    return this.impersonationService.querySessions({
      superAdminId: query.superAdminId,
      targetTenantId: query.targetTenantId,
      status: query.status,
      reason: query.reason,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      page: query.page,
      limit: query.limit,
    });
  }

  // ============================================================================
  // Action Logging
  // ============================================================================

  @Post('sessions/:id/log-action')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logAction(@Param('id') sessionId: string, @Body() dto: LogActionDto) {
    await this.impersonationService.logAction(
      sessionId,
      dto.action,
      dto.resource,
      dto.resourceId,
      dto.details,
    );
  }

  @Post('sessions/:id/log-resource-access')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logResourceAccess(
    @Param('id') sessionId: string,
    @Body() dto: { resourceType: string; resourceId: string; action: string },
  ) {
    await this.impersonationService.logResourceAccess(
      sessionId,
      dto.resourceType,
      dto.resourceId,
      dto.action,
    );
  }

  // ============================================================================
  // Audit & Reports
  // ============================================================================

  @Get('audit/summary')
  async getAuditSummary(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.impersonationService.getAuditSummary(
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }
}
