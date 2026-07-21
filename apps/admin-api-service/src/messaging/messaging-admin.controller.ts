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
import {
  MESSAGING_ADMIN_PATTERNS,
  type MessagingAdminRpcRequest,
} from '@platform/event-contracts';

import { ConfigService } from '@nestjs/config';
import { CurrentUser, CurrentUserData } from '../decorators/current-user.decorator';
import { CreateLegalHoldDto } from './dto/create-legal-hold.dto';
import { ReleaseLegalHoldDto } from './dto/release-legal-hold.dto';
import { TriggerExportDto } from './dto/trigger-export.dto';
import { UpdateRetentionPolicyDto } from './dto/update-retention-policy.dto';

/** Default NATS request timeout when MESSAGING_NATS_TIMEOUT_MS is not configured. */
const DEFAULT_NATS_TIMEOUT_MS = 15_000;

// ── Response Interfaces ────────────────────────────────────────────────

interface ComplianceStatsResponse {
  activeHoldsCount: number;
  retentionPoliciesCount: number;
  auditLogEntriesCount: number;
}

interface LegalHoldResponse {
  id: string;
  tenantId: string;
  channelId: string | null;
  reason: string;
  isActive: boolean;
  createdAt: string;
}

interface RetentionPolicyResponse {
  id: string;
  tenantId: string;
  channelId: string | null;
  retentionDays: number;
}

interface AuditLogResponse {
  items: Array<{ id: string; action: string; resourceType: string; createdAt: string }>;
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}

interface ExportResponse {
  exportId: string;
  status: string;
}

interface PersonaResponse {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
}

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
    @Query('tenantId') tenantId: string,
  ): Promise<ComplianceStatsResponse> {
    return this.sendNatsRequest<ComplianceStatsResponse>(
      MESSAGING_ADMIN_PATTERNS.complianceStats,
      { tenantId },
    );
  }

  // ── Legal Holds ─────────────────────────────────────────────────────

  /**
   * List all legal holds for a tenant.
   * @param tenantId - UUID of the target tenant
   */
  @Get('compliance/legal-holds')
  @ApiOperation({ summary: 'List legal holds for a tenant' })
  async getLegalHolds(
    @Query('tenantId') tenantId: string,
  ): Promise<LegalHoldResponse[]> {
    return this.sendNatsRequest<LegalHoldResponse[]>(
      MESSAGING_ADMIN_PATTERNS.getLegalHolds,
      { tenantId },
    );
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
  ): Promise<LegalHoldResponse> {
    return this.sendNatsRequest<LegalHoldResponse>(
      MESSAGING_ADMIN_PATTERNS.createLegalHold,
      {
        tenantId: dto.tenantId,
        userId: user.id,
        channelId: dto.channelId ?? null,
        reason: dto.reason,
        legalMatterId: dto.legalMatterId,
        legalMatterDescription: dto.legalMatterDescription,
        requestedBy: dto.requestedBy,
        expiresAt: dto.expiresAt,
      },
    );
  }

  /**
   * Release (deactivate) an existing legal hold.
   *
   * POST (not DELETE) because release is a dual-approver command that carries a
   * body: the countersigning `approverId` and the ≥50-char `releaseReason`
   * required by the LEGAL-MEDIUM-002 protocol. A bodyless DELETE structurally
   * could not carry them, so every release deterministically failed (APA-163).
   * `ReleaseLegalHoldDto` + the global ValidationPipe reject a bad payload with
   * a 400 at the edge; the forwarded NATS payload is contract-typed.
   *
   * @param id - UUID of the legal hold to release
   */
  @Post('compliance/legal-holds/:id/release')
  @ApiOperation({ summary: 'Release a legal hold (dual-approver)' })
  async releaseLegalHold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleaseLegalHoldDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<LegalHoldResponse> {
    return this.sendNatsRequest<LegalHoldResponse>(
      MESSAGING_ADMIN_PATTERNS.releaseLegalHold,
      {
        holdId: id,
        tenantId: dto.tenantId,
        userId: user.id,
        approverId: dto.approverId,
        releaseReason: dto.releaseReason,
      },
    );
  }

  // ── Retention Policies ──────────────────────────────────────────────

  /**
   * List all retention policies for a tenant.
   * @param tenantId - UUID of the target tenant
   */
  @Get('retention/policies')
  @ApiOperation({ summary: 'List retention policies for a tenant' })
  async getRetentionPolicies(
    @Query('tenantId') tenantId: string,
  ): Promise<RetentionPolicyResponse[]> {
    return this.sendNatsRequest<RetentionPolicyResponse[]>(
      MESSAGING_ADMIN_PATTERNS.getRetentionPolicies,
      { tenantId },
    );
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
  ): Promise<RetentionPolicyResponse> {
    return this.sendNatsRequest<RetentionPolicyResponse>(
      MESSAGING_ADMIN_PATTERNS.updateRetentionPolicy,
      {
        tenantId: id,
        userId: user.id,
        channelId: dto.channelId ?? null,
        retentionDays: dto.retentionDays,
      },
    );
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
    @Query('tenantId') tenantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<AuditLogResponse> {
    return this.sendNatsRequest<AuditLogResponse>(
      MESSAGING_ADMIN_PATTERNS.getAuditLog,
      {
        tenantId,
        limit: limit ? parseInt(limit, 10) : 25,
        cursor: cursor ?? null,
        userId,
        action,
        resourceType,
        startDate,
        endDate,
      },
    );
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
  ): Promise<ExportResponse> {
    return this.sendNatsRequest<ExportResponse>(
      MESSAGING_ADMIN_PATTERNS.triggerExport,
      {
        tenantId: id,
        userId: user.id,
        format: dto.format ?? 'json',
      },
    );
  }

  // ── AI Personas ─────────────────────────────────────────────────────

  /**
   * Get AI personas configuration for a tenant.
   * @param tenantId - UUID of the target tenant
   */
  @Get('personas')
  @ApiOperation({ summary: 'Get AI personas configuration' })
  async getPersonas(
    @Query('tenantId') tenantId: string,
  ): Promise<PersonaResponse[]> {
    return this.sendNatsRequest<PersonaResponse[]>(
      MESSAGING_ADMIN_PATTERNS.getPersonas,
      { tenantId },
    );
  }

  /**
   * Update an AI persona configuration.
   * Not yet implemented in messaging-service (personas are currently static).
   * @param id - Persona ID
   */
  @Put('personas/:id')
  @ApiOperation({ summary: 'Update AI persona configuration' })
  async updatePersona(
    @Param('id') _id: string,
  ): Promise<never> {
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
   * The payload is constrained to the shared `MessagingAdminRpcRequest` contract
   * keyed by `pattern`, so a callsite that omits a required field (e.g. the
   * dual-approver `approverId` / `releaseReason` on `releaseLegalHold`) is a
   * COMPILE error, not a click-time retried 502 (APA-163). `P` is inferred from
   * the pattern argument; `T` (the response) is supplied explicitly per call
   * until the response side of the contract lands (APA-165/166).
   *
   * @param pattern - A `request.messaging.admin.*` subject from `MESSAGING_ADMIN_PATTERNS`
   * @param payload - Request payload, type-checked against the contract for `pattern`
   * @returns Response from messaging-service
   * @throws HttpException on timeout or NATS errors
   */
  private async sendNatsRequest<
    T,
    P extends keyof MessagingAdminRpcRequest = keyof MessagingAdminRpcRequest,
  >(
    pattern: P,
    payload: MessagingAdminRpcRequest[P],
  ): Promise<T> {
    try {
      const result = await firstValueFrom(
        this.natsClient.send<T>(pattern, payload).pipe(
          timeout(this.natsTimeoutMs),
          catchError((err: Error) => {
            this.logger.error(
              `NATS request failed: pattern=${pattern}, error=${err.message}`,
            );
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

      throw new HttpException(
        `Messaging service error: ${message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
