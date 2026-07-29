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
import { Type } from 'class-transformer';
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
import { Request } from 'express';
import { getAuthUser } from '../../shared/authenticated-request';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';

import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
  ImpersonationPermission,
  SafeImpersonationSession,
  IMPERSONATION_MAX_SESSION_MINUTES,
} from '../entities/impersonation-session.entity';
import { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import {
  ImpersonationService,
  StartImpersonationRequest,
} from '../services/impersonation.service';
import type {
  ActiveSessionCount,
  ImpersonationAuditSummary,
  ImpersonationEligibility,
  ImpersonationValidation,
  StartedImpersonationSession,
} from '../services/impersonation.service';

// ============================================================================
// DTOs with Validation
// ============================================================================

export class GrantPermissionDto {
  @IsUUID('4', { message: 'Invalid super admin ID format' })
  superAdminId!: string;

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
  // RBAC-MEDIUM-009 (M7): grants previously accepted up to 1440 min (24 h),
  // violating the 1-hour impersonation policy the SSoT constant owns.
  @Max(IMPERSONATION_MAX_SESSION_MINUTES)
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
  @IsObject()
  permissions?: Partial<ImpersonationPermissions>;

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

export class QueryPermissionsDto {
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

export class QuerySessionsDto {
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

  /**
   * Free-text over the target tenant name and the acting admin's email.
   *
   * Server-side because the list is paginated. The admin panel's search box
   * used to filter the rows already in the browser, which is indistinguishable
   * from a real search while a single page holds everything and quietly wrong
   * the moment it does not — the operator sees "no results" for a session that
   * exists on page 2.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
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
  async queryPermissions(
    @Query() query: QueryPermissionsDto,
  ): Promise<IStandardPaginatedResult<ImpersonationPermission>> {
    return this.impersonationService.queryPermissions({
      tenantId: query.tenantId,
      isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
      page: query.page,
      limit: query.limit,
    });
  }

  // APA-370: granting an impersonation permission is as sensitive as the
  // session-lifecycle endpoints below (all @ThrottleSensitive) — tighten it too.
  @ThrottleSensitive()
  @Post('permissions')
  async grantPermission(
    @Body() dto: GrantPermissionDto,
    @Req() req: Request,
  ): Promise<ImpersonationPermission> {
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
  async getPermission(
    @Param('superAdminId') superAdminId: string,
  ): Promise<ImpersonationPermission | null> {
    return this.impersonationService.getImpersonationPermission(superAdminId);
  }

  // APA-370: revoking an impersonation permission is a sensitive security
  // mutation; tighten it to the sensitive bucket like grant + session lifecycle.
  @ThrottleSensitive()
  @Post('permissions/:superAdminId/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokePermission(
    @Param('superAdminId') superAdminId: string,
    @Req() req: Request,
  ): Promise<void> {
    // The actor comes from the verified JWT, never from the request — the same
    // rule `grantPermission` above already follows (ADMIN-MEDIUM-056). Revoking
    // impersonation permission is at least as security-relevant as granting it,
    // and until now it recorded no actor at all.
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    await this.impersonationService.revokeImpersonationPermission(superAdminId, user.id);
  }

  @Get('permissions/:superAdminId/check/:tenantId')
  async checkPermission(
    @Param('superAdminId') superAdminId: string,
    @Param('tenantId') tenantId: string,
  ): Promise<ImpersonationEligibility> {
    return this.impersonationService.canImpersonate(superAdminId, tenantId);
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  // Fix: H8 -- per-route throttle: impersonation start is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('sessions/start')
  async startImpersonation(
    @Body() dto: StartImpersonationDto,
    @Req() req: Request,
  ): Promise<StartedImpersonationSession> {
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
  @ThrottleSensitive()
  @Post('sessions/:id/end')
  async endImpersonation(
    @Param('id') sessionId: string,
    @Body() dto: EndImpersonationDto,
    @Req() req: Request,
  ): Promise<SafeImpersonationSession> {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.endImpersonation(sessionId, dto.reason, user.id);
  }

  // Fix: H8 -- per-route throttle: session terminate is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('sessions/:id/terminate')
  async terminateSession(
    @Param('id') sessionId: string,
    @Body() dto: TerminateSessionDto,
    @Req() req: Request,
  ): Promise<SafeImpersonationSession> {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.terminateSession(sessionId, user.id, dto.reason);
  }

  // Fix: H21 -- extend session endpoint
  @ThrottleSensitive()
  @Post('sessions/:id/extend')
  async extendSession(
    @Param('id') sessionId: string,
    @Body() dto: ExtendSessionDto,
    @Req() req: Request,
  ): Promise<SafeImpersonationSession> {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.extendSession(
      sessionId,
      dto.additionalMinutes,
      user.id,
    );
  }

  /**
   * SECURITY (ADMIN-MEDIUM-001): Passes request IP to validateSession
   * for IP binding enforcement. A token bound to IP A is rejected when
   * presented from IP B.
   */
  @Get('sessions/validate')
  async validateSession(
    @Headers('x-impersonation-token') token: string,
    @Req() req: Request,
  ): Promise<ImpersonationValidation> {
    const requestIp = (req.ip || req.socket.remoteAddress) ?? undefined;
    const context = await this.impersonationService.validateSession(token, requestIp);
    return { valid: !!context, context };
  }

  @Get('sessions/active')
  async getActiveSessions(): Promise<SafeImpersonationSession[]> {
    return this.impersonationService.getActiveSessions();
  }

  @Get('sessions/active/count')
  async getActiveSessionCount(): Promise<ActiveSessionCount> {
    return { count: this.impersonationService.getActiveSessionCount() };
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string): Promise<SafeImpersonationSession> {
    return this.impersonationService.getSession(id);
  }

  @Get('sessions')
  async querySessions(
    @Query() query: QuerySessionsDto,
  ): Promise<IStandardPaginatedResult<SafeImpersonationSession>> {
    return this.impersonationService.querySessions({
      superAdminId: query.superAdminId,
      targetTenantId: query.targetTenantId,
      status: query.status,
      reason: query.reason,
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
  async logAction(
    @Param('id') sessionId: string,
    @Body() dto: LogActionDto,
  ): Promise<void> {
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
    @Body() dto: LogResourceAccessDto,
  ): Promise<void> {
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
  ): Promise<ImpersonationAuditSummary> {
    return this.impersonationService.getAuditSummary(
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }
}
