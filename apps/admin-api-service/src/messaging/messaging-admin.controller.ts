/**
 * @module MessagingAdminController
 * @description REST gateway for admin-panel messaging operations.
 * Proxies requests to messaging-service via NATS request-reply pattern.
 *
 * Every endpoint is guarded by PlatformAdminGuard (APP_GUARD in app.module.ts)
 * which restricts access to SUPER_ADMIN / PLATFORM_ADMIN roles.
 *
 * Endpoints that messaging-service does not yet expose return 501 Not Implemented
 * with a clear message -- no mock data is ever returned.
 *
 * @see ADR-012 Phase 3 (Compliance)
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  Inject,
  Logger,
  HttpCode,
  HttpStatus,
  HttpException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { firstValueFrom, timeout, catchError, throwError } from 'rxjs';

import { ConfigService } from '@nestjs/config';
import { RequireRecentMfa } from '@aquaculture/backend-common/guards';
import {
  ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1,
  ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1,
  ADMIN_MESSAGING_RPC_SUBJECTS_V1,
  type AdminLegalHoldReleaseOperationV1,
  type AdminLegalHoldV1,
  type AdminMessagingComplianceStatsV1,
  type AdminMessagingAuditPageV1,
  type AdminMessagingExportResultV1,
  type AdminMessagingPersonaV1,
  type AdminMessagingRetentionPolicyV1,
  type AdminMessagingRpcRequestV1,
  type AdminMessagingRpcResponseV1,
  type AdminMessagingRpcSubjectV1,
  type AdminRecentMfaActorV1,
} from '@platform/admin-http-contracts';
import { CurrentUser, CurrentUserData } from '../decorators/current-user.decorator';
import {
  CreateLegalHoldDto,
  TriggerExportDto,
  UpdateRetentionPolicyDto,
} from './dto/messaging-admin.dto';
import {
  AuthorizeLegalHoldReleaseOperationDto,
  CreateLegalHoldReleaseOperationDto,
  LegalHoldReleaseOperationQueryDto,
} from './dto/legal-hold-release-operation.dto';

/** Default NATS request timeout when MESSAGING_NATS_TIMEOUT_MS is not configured. */
const DEFAULT_NATS_TIMEOUT_MS = 15_000;

// ── Controller ──────────────────────────────────────────────────────────

@ApiTags('Messaging Admin')
@Controller('messaging')
export class MessagingAdminController {
  private readonly logger = new Logger(MessagingAdminController.name);

  private readonly natsTimeoutMs: number;

  constructor(
    @Inject('MESSAGING_NATS_CLIENT')
    private readonly natsClient: ClientProxy,
    private readonly configService: ConfigService,
  ) {
    this.natsTimeoutMs = this.configService.get<number>(
      'MESSAGING_NATS_TIMEOUT_MS',
      DEFAULT_NATS_TIMEOUT_MS,
    );
  }

  // ── Compliance Stats ────────────────────────────────────────────────

  /**
   * Get compliance statistics for a tenant's messaging data.
   * @param tenantId - UUID of the target tenant
   */
  @Get('compliance/stats')
  @ApiOperation({ summary: 'Get messaging compliance statistics' })
  async getComplianceStats(
    @Query('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<AdminMessagingComplianceStatsV1> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.complianceStats, { tenantId });
  }

  // ── Legal Holds ─────────────────────────────────────────────────────

  /**
   * List all legal holds for a tenant.
   * @param tenantId - UUID of the target tenant
   */
  @Get('compliance/legal-holds')
  @ApiOperation({ summary: 'List legal holds for a tenant' })
  async getLegalHolds(
    @Query('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<readonly AdminLegalHoldV1[]> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHolds, { tenantId });
  }

  /**
   * Create a new legal hold on messaging data.
   */
  @Post('compliance/legal-holds')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a legal hold' })
  async createLegalHold(
    @Body() dto: CreateLegalHoldDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminLegalHoldV1> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHold, {
      tenantId: dto.tenantId,
      userId: user.id,
      channelId: dto.channelId ?? null,
      reason: dto.reason,
      legalMatterId: dto.legalMatterId,
      legalMatterDescription: dto.legalMatterDescription,
      requestedBy: dto.requestedBy,
      expiresAt: dto.expiresAt,
    });
  }

  /**
   * Open a release operation. The hold remains active until a distinct admin
   * authorizes it through their own recent-MFA session.
   */
  @Post('compliance/legal-holds/:id/release-operations')
  @HttpCode(HttpStatus.CREATED)
  @RequireRecentMfa(ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1)
  @ApiOperation({ summary: 'Request two-person legal-hold release' })
  async createLegalHoldReleaseOperation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLegalHoldReleaseOperationDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminLegalHoldReleaseOperationV1> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHoldReleaseOperation, {
      holdId: id,
      tenantId: dto.tenantId,
      requestId: dto.requestId,
      releaseReason: dto.releaseReason,
      initiator: this.toRecentMfaActor(user),
    });
  }

  @Post('compliance/legal-hold-release-operations/:id/authorizations')
  @HttpCode(HttpStatus.OK)
  @RequireRecentMfa(ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1)
  @ApiOperation({ summary: 'Countersign and execute legal-hold release' })
  async authorizeLegalHoldReleaseOperation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AuthorizeLegalHoldReleaseOperationDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminLegalHoldReleaseOperationV1> {
    return this.sendNatsRequest(
      ADMIN_MESSAGING_RPC_SUBJECTS_V1.authorizeLegalHoldReleaseOperation,
      {
        operationId: id,
        tenantId: dto.tenantId,
        requestId: dto.requestId,
        approver: this.toRecentMfaActor(user),
      },
    );
  }

  @Get('compliance/legal-hold-release-operations')
  @ApiOperation({ summary: 'List legal-hold release operations' })
  async getLegalHoldReleaseOperations(
    @Query() query: LegalHoldReleaseOperationQueryDto,
  ): Promise<readonly AdminLegalHoldReleaseOperationV1[]> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHoldReleaseOperations, {
      tenantId: query.tenantId,
      status: query.status,
    });
  }

  // ── Retention Policies ──────────────────────────────────────────────

  /**
   * List all retention policies for a tenant.
   * @param tenantId - UUID of the target tenant
   */
  @Get('retention/policies')
  @ApiOperation({ summary: 'List retention policies for a tenant' })
  async getRetentionPolicies(
    @Query('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<readonly AdminMessagingRetentionPolicyV1[]> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getRetentionPolicies, { tenantId });
  }

  /**
   * Create or update a retention policy.
   * @param id - Tenant ID (used as scope identifier)
   */
  @Put('retention/policies/:id')
  @ApiOperation({ summary: 'Update a retention policy' })
  async updateRetentionPolicy(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRetentionPolicyDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminMessagingRetentionPolicyV1> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.updateRetentionPolicy, {
      tenantId: id,
      userId: user.id,
      channelId: dto.channelId ?? null,
      retentionDays: dto.retentionDays,
    });
  }

  // ── Monitoring ──────────────────────────────────────────────────────

  /**
   * Get messaging monitoring statistics.
   * Not yet implemented in messaging-service.
   */
  @Get('monitoring/stats')
  @ApiOperation({ summary: 'Get messaging monitoring statistics' })
  async getMonitoringStats(): Promise<never> {
    throw new HttpException(
      'Messaging monitoring stats not yet implemented in messaging-service. ' +
        'Requires real-time metrics aggregation endpoint.',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  // ── Audit Log ───────────────────────────────────────────────────────

  /**
   * Get paginated compliance audit log entries.
   * @param tenantId - UUID of the target tenant
   * @param limit - Number of entries per page (max 100)
   * @param cursor - Cursor for pagination
   */
  @Get('audit')
  @ApiOperation({ summary: 'Get compliance audit log entries' })
  async getAuditLog(
    @Query('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<AdminMessagingAuditPageV1> {
    return this.sendNatsRequest(ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1, {
      tenantId,
      limit: limit ? parseInt(limit, 10) : 25,
      cursor: cursor ?? null,
      userId,
      action,
      resourceType,
      startDate,
      endDate,
    });
  }

  // ── Tenant Messaging Overview ───────────────────────────────────────

  /**
   * Get tenant list with messaging statistics.
   * Not yet implemented in messaging-service.
   */
  @Get('tenants')
  @ApiOperation({ summary: 'List tenants with messaging stats' })
  async getTenants(): Promise<never> {
    throw new HttpException(
      'Tenant messaging overview not yet implemented in messaging-service. ' +
        'Requires cross-tenant aggregation endpoint.',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  // ── Data Export ─────────────────────────────────────────────────────

  /**
   * Trigger a data export for a specific tenant.
   * @param id - UUID of the tenant to export
   */
  @Post('tenants/:id/export')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger tenant data export' })
  async triggerExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriggerExportDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminMessagingExportResultV1> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.triggerExport, {
      tenantId: id,
      userId: user.id,
      format: dto.format ?? 'json',
    });
  }

  // ── AI Personas ─────────────────────────────────────────────────────

  /**
   * Get AI personas configuration for a tenant.
   * @param tenantId - UUID of the target tenant
   */
  @Get('personas')
  @ApiOperation({ summary: 'Get AI personas configuration' })
  async getPersonas(
    @Query('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<readonly AdminMessagingPersonaV1[]> {
    return this.sendNatsRequest(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getPersonas, { tenantId });
  }

  /**
   * Update an AI persona configuration.
   * Not yet implemented in messaging-service (personas are currently static).
   * @param id - Persona ID
   */
  @Put('personas/:id')
  @ApiOperation({ summary: 'Update AI persona configuration' })
  async updatePersona(@Param('id') _id: string): Promise<never> {
    throw new HttpException(
      'AI persona configuration update not yet implemented in messaging-service. ' +
        'Personas are currently static; per-tenant configuration is planned.',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  // ── NATS Helper ─────────────────────────────────────────────────────

  /**
   * Send a request to messaging-service via NATS and return the response.
   *
   * @param pattern - NATS message pattern (e.g., 'request.messaging.admin.complianceStats')
   * @param payload - Request payload
   * @returns Response from messaging-service
   * @throws HttpException on timeout or NATS errors
   */
  private async sendNatsRequest<TSubject extends AdminMessagingRpcSubjectV1>(
    pattern: TSubject,
    payload: AdminMessagingRpcRequestV1[TSubject],
  ): Promise<AdminMessagingRpcResponseV1[TSubject]> {
    try {
      const result = await firstValueFrom(
        this.natsClient
          .send<
            AdminMessagingRpcResponseV1[TSubject],
            AdminMessagingRpcRequestV1[TSubject]
          >(pattern, payload)
          .pipe(
            timeout(this.natsTimeoutMs),
            catchError((err: Error) => {
              this.logger.error(`NATS request failed: pattern=${pattern}, error=${err.message}`);
              return throwError(() => err);
            }),
          ),
      );
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // NATS timeout
      if (message.includes('Timeout')) {
        throw new HttpException(
          `Messaging service did not respond within ${this.natsTimeoutMs}ms`,
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }

      // NATS connection issues
      if (message.includes('not connected') || message.includes('CONN_CLOSED')) {
        throw new HttpException(
          'Messaging service is currently unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // Re-throw domain errors from messaging-service
      if (err instanceof HttpException) {
        throw err;
      }

      throw new HttpException(`Messaging service error: ${message}`, HttpStatus.BAD_GATEWAY);
    }
  }

  private toRecentMfaActor(user: CurrentUserData): AdminRecentMfaActorV1 {
    if (
      user.mfaVerified !== true ||
      user.iat === undefined ||
      user.jti === undefined ||
      user.jti.trim().length === 0
    ) {
      throw new HttpException(
        'A recent MFA step-up access token is required',
        HttpStatus.FORBIDDEN,
      );
    }
    return {
      actorId: user.id,
      roles: user.roles,
      mfaVerified: true,
      tokenIssuedAt: new Date(user.iat * 1_000).toISOString(),
      tokenId: user.jti,
    };
  }
}
