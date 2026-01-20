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
} from '@nestjs/common';
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

// ============================================================================
// DTOs
// ============================================================================

class GrantPermissionDto {
  superAdminId: string;
  superAdminEmail?: string;
  allowedTenants?: string[];
  restrictedTenants?: string[];
  defaultPermissions?: ImpersonationPermissions;
  maxSessionDurationMinutes?: number;
  maxConcurrentSessions?: number;
  requireReason?: boolean;
  requireTicketReference?: boolean;
  notifyTenantAdmin?: boolean;
  expiresAt?: string;
  notes?: string;
}

class StartImpersonationDto {
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  reason: ImpersonationReason;
  reasonDetails?: string;
  ticketReference?: string;
  permissions?: Partial<ImpersonationPermissions>;
  durationMinutes?: number;
}

class LogActionDto {
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('impersonation')
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  // ============================================================================
  // Permission Management
  // ============================================================================

  @Get('permissions')
  async queryPermissions(
    @Query('tenantId') tenantId?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.impersonationService.queryPermissions({
      tenantId,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('stats')
  async getStats() {
    return this.impersonationService.getImpersonationStats();
  }

  @Post('permissions')
  async grantPermission(
    @Body() dto: GrantPermissionDto,
    @Headers('x-admin-id') grantedBy: string,
  ) {
    return this.impersonationService.grantImpersonationPermission({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      grantedBy,
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
    @Headers('x-admin-id') superAdminId: string,
    @Headers('x-admin-email') superAdminEmail: string,
    @Req() req: Request,
  ) {
    const request: StartImpersonationRequest = {
      superAdminId,
      superAdminEmail,
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
    @Headers('x-admin-id') adminId: string,
  ) {
    return this.impersonationService.endImpersonation(sessionId, dto.reason, adminId);
  }

  @Post('sessions/:id/terminate')
  async terminateSession(
    @Param('id') sessionId: string,
    @Body() dto: { reason: string },
    @Headers('x-admin-id') terminatedBy: string,
  ) {
    return this.impersonationService.terminateSession(sessionId, terminatedBy, dto.reason);
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
  async querySessions(
    @Query('superAdminId') superAdminId?: string,
    @Query('targetTenantId') targetTenantId?: string,
    @Query('status') status?: ImpersonationStatus,
    @Query('reason') reason?: ImpersonationReason,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.impersonationService.querySessions({
      superAdminId,
      targetTenantId,
      status,
      reason,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
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
