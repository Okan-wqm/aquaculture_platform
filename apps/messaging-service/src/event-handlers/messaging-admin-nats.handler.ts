/**
 * @module MessagingAdminNatsHandler
 * @description NATS request-reply handler for admin-panel compliance operations.
 * Exposes messaging-service compliance, retention, legal hold, audit, data export,
 * and AI persona operations via `request.messaging.admin.*` patterns.
 *
 * Consumed by admin-api-service's MessagingAdminController, which proxies
 * REST calls from the admin-panel frontend.
 *
 * @see ADR-012 Phase 3 (Compliance)
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { RetentionPolicyService } from '../compliance/services/retention-policy.service';
import { ComplianceAuditService } from '../compliance/services/compliance-audit.service';
import { DataExportService, ExportFormat } from '../compliance/services/data-export.service';
import { AiPersonasRegistryService } from '../ai/services/ai-personas-registry.service';

import { SetRetentionPolicyCommand } from '../compliance/commands/set-retention-policy.command';
import { ToggleLegalHoldCommand } from '../compliance/commands/toggle-legal-hold.command';
import { GetAuditLogQuery } from '../compliance/queries/get-audit-log.query';
import { GetRetentionPoliciesQuery } from '../compliance/queries/get-retention-policies.query';
import { RetentionPolicy } from '../compliance/entities/retention-policy.entity';
import { LegalHold } from '../compliance/entities/legal-hold.entity';

// ── Payload Interfaces ──────────────────────────────────────────────────

interface TenantScopedPayload {
  tenantId: string;
}

interface ComplianceStatsPayload extends TenantScopedPayload {}

interface GetLegalHoldsPayload extends TenantScopedPayload {}

interface CreateLegalHoldPayload extends TenantScopedPayload {
  userId: string;
  channelId: string | null;
  reason: string;
  legalMatterId: string;
  legalMatterDescription?: string;
  requestedBy?: string;
  expiresAt?: string;
}

interface ReleaseLegalHoldPayload extends TenantScopedPayload {
  holdId: string;
  userId: string;
}

interface GetRetentionPoliciesPayload extends TenantScopedPayload {}

interface UpdateRetentionPolicyPayload extends TenantScopedPayload {
  userId: string;
  channelId: string | null;
  retentionDays: number;
}

interface GetAuditLogPayload extends TenantScopedPayload {
  limit: number;
  cursor: string | null;
  userId?: string;
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
}

interface TriggerExportPayload extends TenantScopedPayload {
  userId: string;
  format: ExportFormat;
}

interface GetPersonasPayload extends TenantScopedPayload {}

// ── Handler ─────────────────────────────────────────────────────────────

@Controller()
export class MessagingAdminNatsHandler {
  private readonly logger = new Logger(MessagingAdminNatsHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly legalHoldService: LegalHoldService,
    private readonly retentionPolicyService: RetentionPolicyService,
    private readonly auditService: ComplianceAuditService,
    private readonly exportService: DataExportService,
    private readonly personasService: AiPersonasRegistryService,
  ) {}

  // ── Compliance Stats ────────────────────────────────────────────────

  /**
   * Return compliance statistics for a tenant.
   */
  @MessagePattern('request.messaging.admin.complianceStats')
  async getComplianceStats(
    @Payload() data: ComplianceStatsPayload,
  ): Promise<{
    messagesUnderHold: number;
    activeHoldsCount: number;
    retentionPoliciesCount: number;
    auditLogEntriesCount: number;
  }> {
    this.logger.debug(`Admin request: complianceStats for tenant=${data.tenantId}`);

    const [activeHolds, policies] = await Promise.all([
      this.legalHoldService.getActiveHolds(data.tenantId),
      this.queryBus.execute<GetRetentionPoliciesQuery, RetentionPolicy[]>(
        new GetRetentionPoliciesQuery(data.tenantId),
      ),
    ]);

    return {
      messagesUnderHold: 0, // Computed at query time -- placeholder
      activeHoldsCount: activeHolds.length,
      retentionPoliciesCount: policies.length,
      auditLogEntriesCount: 0, // Would need separate count query
    };
  }

  // ── Legal Holds ─────────────────────────────────────────────────────

  /**
   * Return all legal holds for a tenant.
   */
  @MessagePattern('request.messaging.admin.getLegalHolds')
  async getLegalHolds(
    @Payload() data: GetLegalHoldsPayload,
  ): Promise<LegalHold[]> {
    this.logger.debug(`Admin request: getLegalHolds for tenant=${data.tenantId}`);
    return this.legalHoldService.getHolds(data.tenantId);
  }

  /**
   * Create (activate) a new legal hold.
   */
  @MessagePattern('request.messaging.admin.createLegalHold')
  async createLegalHold(
    @Payload() data: CreateLegalHoldPayload,
  ): Promise<LegalHold> {
    this.logger.debug(`Admin request: createLegalHold for tenant=${data.tenantId}`);

    return this.commandBus.execute(
      new ToggleLegalHoldCommand(
        data.tenantId,
        data.userId,
        true, // activate
        null, // holdId not needed for activation
        data.channelId,
        data.reason,
        data.legalMatterId,
        data.legalMatterDescription ?? null,
        data.requestedBy ?? null,
        data.expiresAt ? new Date(data.expiresAt) : null,
      ),
    );
  }

  /**
   * Release (deactivate) an existing legal hold.
   */
  @MessagePattern('request.messaging.admin.releaseLegalHold')
  async releaseLegalHold(
    @Payload() data: ReleaseLegalHoldPayload,
  ): Promise<LegalHold> {
    this.logger.debug(`Admin request: releaseLegalHold holdId=${data.holdId}`);

    return this.commandBus.execute(
      new ToggleLegalHoldCommand(
        data.tenantId,
        data.userId,
        false, // release
        data.holdId,
        null,
        null,
        null,
        null,
        null,
        null,
      ),
    );
  }

  // ── Retention Policies ──────────────────────────────────────────────

  /**
   * Return all retention policies for a tenant.
   */
  @MessagePattern('request.messaging.admin.getRetentionPolicies')
  async getRetentionPolicies(
    @Payload() data: GetRetentionPoliciesPayload,
  ): Promise<RetentionPolicy[]> {
    this.logger.debug(`Admin request: getRetentionPolicies for tenant=${data.tenantId}`);
    return this.queryBus.execute(
      new GetRetentionPoliciesQuery(data.tenantId),
    );
  }

  /**
   * Create or update a retention policy.
   */
  @MessagePattern('request.messaging.admin.updateRetentionPolicy')
  async updateRetentionPolicy(
    @Payload() data: UpdateRetentionPolicyPayload,
  ): Promise<RetentionPolicy> {
    this.logger.debug(
      `Admin request: updateRetentionPolicy tenant=${data.tenantId}, days=${data.retentionDays}`,
    );

    return this.commandBus.execute(
      new SetRetentionPolicyCommand(
        data.tenantId,
        data.userId,
        data.channelId,
        data.retentionDays,
      ),
    );
  }

  // ── Audit Log ───────────────────────────────────────────────────────

  /**
   * Return paginated compliance audit log entries.
   */
  @MessagePattern('request.messaging.admin.getAuditLog')
  async getAuditLog(
    @Payload() data: GetAuditLogPayload,
  ): Promise<{
    items: unknown[];
    hasMore: boolean;
    cursor: string | null;
    totalCount: number;
  }> {
    this.logger.debug(`Admin request: getAuditLog for tenant=${data.tenantId}`);

    return this.queryBus.execute(
      new GetAuditLogQuery(
        data.tenantId,
        Math.min(data.limit, 100),
        data.cursor ?? null,
        data.userId ?? null,
        (data.action as never) ?? null,
        data.resourceType ?? null,
        data.startDate ? new Date(data.startDate) : null,
        data.endDate ? new Date(data.endDate) : null,
      ),
    );
  }

  // ── Data Export ─────────────────────────────────────────────────────

  /**
   * Trigger a tenant-wide data export.
   */
  @MessagePattern('request.messaging.admin.triggerExport')
  async triggerExport(
    @Payload() data: TriggerExportPayload,
  ): Promise<{
    jobId: string;
    status: string;
    format: string;
    recordCount: number;
    isUnderLegalHold: boolean;
    exportedAt: string;
  }> {
    this.logger.debug(
      `Admin request: triggerExport tenant=${data.tenantId}, format=${data.format}`,
    );

    const result = await this.exportService.exportTenant(
      data.tenantId,
      data.format,
      data.userId,
    );

    // IMPORTANT: Do not send the full data payload over NATS — it can be huge.
    // Return metadata only; the actual export data should be retrieved via a
    // separate download endpoint or stored in object storage.
    return {
      jobId: result.jobId,
      status: result.status,
      format: result.format,
      recordCount: result.recordCount,
      isUnderLegalHold: result.isUnderLegalHold,
      exportedAt: result.exportedAt,
    };
  }

  // ── AI Personas ─────────────────────────────────────────────────────

  /**
   * Return available AI personas for a tenant.
   */
  @MessagePattern('request.messaging.admin.getPersonas')
  async getPersonas(
    @Payload() data: GetPersonasPayload,
  ): Promise<Array<{
    id: string | null;
    name: string;
    description: string;
    icon: string;
    color: string;
    capabilities: string[];
  }>> {
    this.logger.debug(`Admin request: getPersonas for tenant=${data.tenantId}`);
    return this.personasService.getAvailablePersonas(data.tenantId);
  }
}
