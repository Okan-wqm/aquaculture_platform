/**
 * @module MessagingAdminController
 * @description REST gateway for admin-panel messaging operations.
 * Proxies requests to messaging-service via NATS request-reply pattern.
 *
 * Every endpoint is guarded by PlatformAdminGuard (APP_GUARD in app.module.ts)
 * which restricts access to SUPER_ADMIN / PLATFORM_ADMIN roles.
 *
 * Every route here is backed by a messaging-service NATS handler. A route
 * whose only behaviour would be to refuse (501 / 410) is not declared:
 * `tests/invariants/admin-no-stub-routes.spec.ts` (ADMIN-HIGH-011).
 *
 * @see ADR-012 Phase 3 (Compliance)
 */
import {
  CreateLegalHoldDto,
  TriggerExportDto,
  UpdateRetentionPolicyDto,
} from './dto/messaging-admin.dto';
import { Destructive, RequiresCapability, TenantParam } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
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
import { CurrentUser, CurrentUserData } from '../decorators/current-user.decorator';

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
    @TenantParam('query') tenantId: string,
  ): Promise<ComplianceStatsResponse> {
    return this.sendNatsRequest<ComplianceStatsResponse>(
      'request.messaging.admin.complianceStats',
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
    @TenantParam('query') tenantId: string,
  ): Promise<LegalHoldResponse[]> {
    return this.sendNatsRequest<LegalHoldResponse[]>(
      'request.messaging.admin.getLegalHolds',
      { tenantId },
    );
  }

  /**
   * Create a new legal hold on messaging data.
   */
  @AuditedOperation({ resource: 'LegalHold', action: 'CREATE' })
  @RequiresCapability('support-ops')
  @Post('compliance/legal-holds')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a legal hold' })
  async createLegalHold(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() dto: CreateLegalHoldDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<LegalHoldResponse> {
    return this.sendNatsRequest<LegalHoldResponse>(
      'request.messaging.admin.createLegalHold',
      {
        tenantId,
        userId: user.id,
        channelId: dto.channelId ?? null,
        reason: dto.reason,
        legalMatterId: dto.legalMatterId,
        legalMatterDescription: dto.legalMatterDescription,
        // ADMIN-CRITICAL-008: the requesting actor is the verified principal.
        requestedBy: user.id,
        expiresAt: dto.expiresAt,
      },
    );
  }

  /**
   * Release (deactivate) an existing legal hold.
   * @param id - UUID of the legal hold to release
   */
  @AuditedOperation({ resource: 'LegalHold', action: 'RELEASE' })
  @Destructive()
  @RequiresCapability('support-ops')
  @Delete('compliance/legal-holds/:id')
  @ApiOperation({ summary: 'Release a legal hold' })
  async releaseLegalHold(
    @Param('id', ParseUUIDPipe) id: string,
    @TenantParam('query') tenantId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<LegalHoldResponse> {
    return this.sendNatsRequest<LegalHoldResponse>(
      'request.messaging.admin.releaseLegalHold',
      {
        holdId: id,
        tenantId,
        userId: user.id,
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
    @TenantParam('query') tenantId: string,
  ): Promise<RetentionPolicyResponse[]> {
    return this.sendNatsRequest<RetentionPolicyResponse[]>(
      'request.messaging.admin.getRetentionPolicies',
      { tenantId },
    );
  }

  /**
   * Create or update a retention policy.
   * @param id - Tenant ID (used as scope identifier)
   */
  @AuditedOperation({ resource: 'RetentionPolicy', action: 'UPDATE' })
  @RequiresCapability('support-ops')
  @Put('retention/policies/:id')
  @ApiOperation({ summary: 'Update a retention policy' })
  async updateRetentionPolicy(
    @TenantParam('param', { key: 'id' }) tenantId: string,
    @Body() dto: UpdateRetentionPolicyDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<RetentionPolicyResponse> {
    return this.sendNatsRequest<RetentionPolicyResponse>(
      'request.messaging.admin.updateRetentionPolicy',
      {
        tenantId,
        userId: user.id,
        channelId: dto.channelId ?? null,
        retentionDays: dto.retentionDays,
      },
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
    @TenantParam('query') tenantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<AuditLogResponse> {
    return this.sendNatsRequest<AuditLogResponse>(
      'request.messaging.admin.getAuditLog',
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

  // ── Data Export ─────────────────────────────────────────────────────

  /**
   * Trigger a data export for a specific tenant.
   * @param id - UUID of the tenant to export
   */
  @AuditedOperation({ resource: 'Export', action: 'TRIGGER' })
  @Destructive()
  @RequiresCapability('support-ops')
  @Post('tenants/:id/export')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger tenant data export' })
  async triggerExport(
    @TenantParam('param', { key: 'id', allow: 'any' }) tenantId: string,
    @Body() dto: TriggerExportDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ExportResponse> {
    return this.sendNatsRequest<ExportResponse>(
      'request.messaging.admin.triggerExport',
      {
        tenantId,
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
    @TenantParam('query') tenantId: string,
  ): Promise<PersonaResponse[]> {
    return this.sendNatsRequest<PersonaResponse[]>(
      'request.messaging.admin.getPersonas',
      { tenantId },
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
  private async sendNatsRequest<T>(
    pattern: string,
    payload: Record<string, unknown>,
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
