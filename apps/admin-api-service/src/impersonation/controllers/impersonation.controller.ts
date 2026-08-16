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
  UnauthorizedException,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RateLimit } from '@aquaculture/backend-common/rate-limit';
import {
  ADMIN_IMPERSONATION_SESSION_SCOPES_V1,
  type AdminImpersonationSessionScopeV1,
} from '@platform/admin-http-contracts';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsEnum,
  IsInt,
  IsArray,
  ArrayNotEmpty,
  IsObject,
  Min,
  Max,
  MaxLength,
  IsDateString,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Request } from 'express';
import { getAuthUser } from '../../shared/authenticated-request';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { ADMIN_RATE_LIMIT_POLICIES } from '../../security/admin-rate-limit.policy';

import {
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
  IMPERSONATION_MAX_SESSION_MINUTES,
  IMPERSONATION_MAX_CONCURRENT_SESSIONS,
  toAdminImpersonationPermissionV1,
} from '../entities/impersonation-session.entity';
import { ImpersonationService, StartImpersonationRequest } from '../services/impersonation.service';

// ============================================================================
// DTOs with Validation
// ============================================================================

export class DefaultImpersonationPermissionsDto implements ImpersonationPermissions {
  @IsBoolean()
  canViewData!: boolean;

  @IsBoolean()
  canModifyData!: boolean;

  @IsBoolean()
  canAccessSettings!: boolean;

  @IsBoolean()
  canManageUsers!: boolean;

  @IsBoolean()
  canViewBilling!: boolean;

  @IsBoolean()
  canExportData!: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  restrictedModules?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedModules?: string[];
}

export class RequestedImpersonationPermissionsDto {
  @IsOptional()
  @IsBoolean()
  canViewData?: boolean;

  @IsOptional()
  @IsBoolean()
  canModifyData?: boolean;

  @IsOptional()
  @IsBoolean()
  canAccessSettings?: boolean;

  @IsOptional()
  @IsBoolean()
  canManageUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  canViewBilling?: boolean;

  @IsOptional()
  @IsBoolean()
  canExportData?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  restrictedModules?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedModules?: string[];
}

export class GrantPermissionDto {
  @IsUUID('4', { message: 'Invalid super admin ID format' })
  superAdminId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  superAdminEmail?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  allowedTenants!: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  restrictedTenants?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => DefaultImpersonationPermissionsDto)
  defaultPermissions?: DefaultImpersonationPermissionsDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  // RBAC-MEDIUM-009 (M7): grants previously accepted up to 1440 min (24 h),
  // violating the 1-hour impersonation policy the SSoT constant owns.
  @Max(IMPERSONATION_MAX_SESSION_MINUTES)
  maxSessionDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(IMPERSONATION_MAX_CONCURRENT_SESSIONS)
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsBoolean()
  requireReason?: boolean;

  @IsOptional()
  @IsBoolean()
  requireTicketReference?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class StartImpersonationDto {
  @IsUUID('4', { message: 'Invalid target tenant ID format' })
  targetTenantId!: string;

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
  reason!: ImpersonationReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reasonDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticketReference?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RequestedImpersonationPermissionsDto)
  permissions?: RequestedImpersonationPermissionsDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  // RBAC-MEDIUM-009 (M7): requests previously accepted up to 480 min (8 h).
  @Max(IMPERSONATION_MAX_SESSION_MINUTES)
  durationMinutes?: number;
}

export class LogActionDto {
  @IsString()
  @MaxLength(100)
  action!: string;

  @IsString()
  @MaxLength(100)
  resource!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;

  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

export class EndImpersonationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class TerminateSessionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class RevokePermissionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class LogResourceAccessDto {
  @IsString()
  @MaxLength(100)
  resourceType!: string;

  @IsString()
  @MaxLength(100)
  resourceId!: string;

  @IsString()
  @MaxLength(100)
  action!: string;
}

export class ExtendSessionDto {
  @IsInt()
  @Min(5, { message: 'Minimum extension is 5 minutes' })
  // RBAC-MEDIUM-009 (M7): an extension can never exceed the absolute session
  // ceiling (the service additionally bounds TOTAL duration to the cap).
  @Max(IMPERSONATION_MAX_SESSION_MINUTES, {
    message: `Maximum extension is ${IMPERSONATION_MAX_SESSION_MINUTES} minutes`,
  })
  additionalMinutes!: number;
}

class QueryPermissionsDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  isActive?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

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

class ImpersonationStatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  windowDays = 30;
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
  @IsIn(ADMIN_IMPERSONATION_SESSION_SCOPES_V1)
  scope?: AdminImpersonationSessionScopeV1;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

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

@ApiTags('Impersonation')
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
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('stats')
  async getStats(@Query() query: ImpersonationStatsQueryDto) {
    return this.impersonationService.getImpersonationStats(query.windowDays);
  }

  @RateLimit(ADMIN_RATE_LIMIT_POLICIES.sensitive)
  @Post('permissions')
  async grantPermission(@Body() dto: GrantPermissionDto, @Req() req: Request) {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.grantImpersonationPermission({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      grantedBy: user.id,
    });
  }

  @Get('permissions/:superAdminId')
  async getPermission(@Param('superAdminId') superAdminId: string) {
    const permission = await this.impersonationService.getImpersonationPermission(superAdminId);
    return permission ? toAdminImpersonationPermissionV1(permission) : null;
  }

  @RateLimit(ADMIN_RATE_LIMIT_POLICIES.sensitive)
  @Post('permissions/:superAdminId/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokePermission(
    @Param('superAdminId') superAdminId: string,
    @Body() dto: RevokePermissionDto,
    @Req() req: Request,
  ) {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    await this.impersonationService.revokeImpersonationPermission(
      superAdminId,
      user.id,
      dto.reason,
    );
  }

  @Get('permissions/:superAdminId/check/:tenantId')
  async checkPermission(
    @Param('superAdminId') superAdminId: string,
    @Param('tenantId') tenantId: string,
  ) {
    const result = await this.impersonationService.canImpersonate(superAdminId, tenantId);
    return {
      ...result,
      permission: result.permission
        ? toAdminImpersonationPermissionV1(result.permission)
        : undefined,
    };
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  // Fix: H8 -- per-route throttle: impersonation start is sensitive (3 req / 5 min)
  @RateLimit(ADMIN_RATE_LIMIT_POLICIES.impersonationStart)
  @Post('sessions/start')
  async startImpersonation(@Body() dto: StartImpersonationDto, @Req() req: Request) {
    // SECURITY FIX: Get admin identity from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    // H-08: email PII removed from JWT — only id (sub) is guaranteed present.
    // superAdminEmail is optional in StartImpersonationRequest post H-08.
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    const request: StartImpersonationRequest = {
      superAdminId: user.id,
      superAdminEmail: user.email, // undefined when H-08 JWT in use — accepted by interface

      ...dto,
      ipAddress: (req.ip || req.socket.remoteAddress) ?? undefined,
      userAgent: req.headers['user-agent'],
    };

    return this.impersonationService.startImpersonation(request);
  }

  // Fix: H8 -- per-route throttle: impersonation end is sensitive (3 req / 5 min)
  @RateLimit(ADMIN_RATE_LIMIT_POLICIES.sensitive)
  @Post('sessions/:id/end')
  async endImpersonation(
    @Param('id') sessionId: string,
    @Body() dto: EndImpersonationDto,
    @Req() req: Request,
  ) {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.endImpersonation(sessionId, dto.reason, user.id);
  }

  // Fix: H8 -- per-route throttle: session terminate is sensitive (3 req / 5 min)
  @RateLimit(ADMIN_RATE_LIMIT_POLICIES.sensitive)
  @Post('sessions/:id/terminate')
  async terminateSession(
    @Param('id') sessionId: string,
    @Body() dto: TerminateSessionDto,
    @Req() req: Request,
  ) {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.terminateSession(sessionId, user.id, dto.reason);
  }

  // Fix: H21 -- extend session endpoint
  @RateLimit(ADMIN_RATE_LIMIT_POLICIES.sensitive)
  @Post('sessions/:id/extend')
  async extendSession(
    @Param('id') sessionId: string,
    @Body() dto: ExtendSessionDto,
    @Req() req: Request,
  ) {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.extendSession(sessionId, dto.additionalMinutes, user.id);
  }

  /**
   * SECURITY (ADMIN-MEDIUM-001): Passes request IP to validateSession
   * for IP binding enforcement. A token bound to IP A is rejected when
   * presented from IP B.
   */
  @Get('sessions/validate')
  async validateSession(@Headers('x-impersonation-token') token: string, @Req() req: Request) {
    const requestIp = (req.ip || req.socket.remoteAddress) ?? undefined;
    const context = await this.impersonationService.validateSession(token, requestIp);
    return { valid: !!context, context };
  }

  @Get('sessions/active')
  async getActiveSessions() {
    return this.impersonationService.getActiveSessions();
  }

  @Get('sessions/active/count')
  async getActiveSessionCount() {
    return { count: await this.impersonationService.getActiveSessionCount() };
  }

  @Get('sessions/:id/actions')
  async getSessionActions(@Param('id') id: string) {
    return this.impersonationService.getSessionActions(id);
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
      scope: query.scope,
      search: query.search,
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
  async logAction(@Param('id') sessionId: string, @Body() dto: LogActionDto, @Req() req: Request) {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    await this.impersonationService.logAction(
      sessionId,
      dto.action,
      dto.resource,
      dto.resourceId,
      dto.details,
      user.id,
    );
  }

  @Post('sessions/:id/log-resource-access')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logResourceAccess(
    @Param('id') sessionId: string,
    @Body() dto: LogResourceAccessDto,
    @Req() req: Request,
  ) {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    await this.impersonationService.logResourceAccess(
      sessionId,
      dto.resourceType,
      dto.resourceId,
      dto.action,
      user.id,
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
