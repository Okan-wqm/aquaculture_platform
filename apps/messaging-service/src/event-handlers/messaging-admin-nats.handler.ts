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
import {
  MESSAGING_ADMIN_PATTERNS,
  type ComplianceStatsRequest,
  type GetLegalHoldsRequest,
  type CreateLegalHoldRequest,
  type ReleaseLegalHoldRequest,
  type GetRetentionPoliciesRequest,
  type UpdateRetentionPolicyRequest,
  type GetAuditLogRequest,
  type TriggerExportRequest,
  type GetPersonasRequest,
} from '@platform/event-contracts';

import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { RetentionPolicyService } from '../compliance/services/retention-policy.service';
import { ComplianceAuditService } from '../compliance/services/compliance-audit.service';
import { DataExportService } from '../compliance/services/data-export.service';
import { AiPersonasRegistryService } from '../ai/services/ai-personas-registry.service';

import { SetRetentionPolicyCommand } from '../compliance/commands/set-retention-policy.command';
import { ToggleLegalHoldCommand } from '../compliance/commands/toggle-legal-hold.command';
import { GetAuditLogQuery } from '../compliance/queries/get-audit-log.query';
import { GetRetentionPoliciesQuery } from '../compliance/queries/get-retention-policies.query';
import { RetentionPolicy } from '../compliance/entities/retention-policy.entity';
import { LegalHold } from '../compliance/entities/legal-hold.entity';
import { ComplianceAction } from '../compliance/entities/compliance-audit-log.entity';

/**
 * Runtime value-set of {@link ComplianceAction} members. Built from the enum so
 * it can never drift from the type. Typed as `readonly string[]` so membership
 * checks accept an arbitrary wire string without a cast.
 */
const COMPLIANCE_ACTION_VALUES: readonly string[] = Object.values(ComplianceAction);

/** Type guard: is a wire string a valid {@link ComplianceAction} member? */
function isComplianceAction(value: string): value is ComplianceAction {
  return COMPLIANCE_ACTION_VALUES.includes(value);
}

/**
 * Narrow a wire string to a {@link ComplianceAction}. The RPC contract carries
 * `action` as a plain string (event-contracts must not import a service entity);
 * an unrecognised value is dropped to `null` (never cast), so a bogus filter
 * can never reach the query as a fake enum member.
 */
function toComplianceAction(value: string | undefined): ComplianceAction | null {
  return value !== undefined && isComplianceAction(value) ? value : null;
}

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
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.complianceStats)
  async getComplianceStats(
    @Payload() data: ComplianceStatsRequest,
  ): Promise<{
    activeHoldsCount: number;
    retentionPoliciesCount: number;
    auditLogEntriesCount: number;
  }> {
    this.logger.debug(`Admin request: complianceStats for tenant=${data.tenantId}`);

    const [activeHolds, policies, auditLogResult] = await Promise.all([
      this.legalHoldService.getActiveHolds(data.tenantId),
      this.queryBus.execute<GetRetentionPoliciesQuery, RetentionPolicy[]>(
        new GetRetentionPoliciesQuery(data.tenantId),
      ),
      this.auditService.getAuditLog(
        { tenantId: data.tenantId },
        1,
        null,
      ),
    ]);

    return {
      activeHoldsCount: activeHolds.length,
      retentionPoliciesCount: policies.length,
      auditLogEntriesCount: auditLogResult.totalCount,
    };
  }

  // ── Legal Holds ─────────────────────────────────────────────────────

  /**
   * Return all legal holds for a tenant.
   */
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.getLegalHolds)
  async getLegalHolds(
    @Payload() data: GetLegalHoldsRequest,
  ): Promise<LegalHold[]> {
    this.logger.debug(`Admin request: getLegalHolds for tenant=${data.tenantId}`);
    return this.legalHoldService.getHolds(data.tenantId);
  }

  /**
   * Create (activate) a new legal hold.
   */
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.createLegalHold)
  async createLegalHold(
    @Payload() data: CreateLegalHoldRequest,
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
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.releaseLegalHold)
  async releaseLegalHold(
    @Payload() data: ReleaseLegalHoldRequest,
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
        data.approverId,
        data.releaseReason,
      ),
    );
  }

  // ── Retention Policies ──────────────────────────────────────────────

  /**
   * Return all retention policies for a tenant.
   */
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.getRetentionPolicies)
  async getRetentionPolicies(
    @Payload() data: GetRetentionPoliciesRequest,
  ): Promise<RetentionPolicy[]> {
    this.logger.debug(`Admin request: getRetentionPolicies for tenant=${data.tenantId}`);
    return this.queryBus.execute(
      new GetRetentionPoliciesQuery(data.tenantId),
    );
  }

  /**
   * Create or update a retention policy.
   */
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.updateRetentionPolicy)
  async updateRetentionPolicy(
    @Payload() data: UpdateRetentionPolicyRequest,
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
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.getAuditLog)
  async getAuditLog(
    @Payload() data: GetAuditLogRequest,
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
        toComplianceAction(data.action),
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
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.triggerExport)
  async triggerExport(
    @Payload() data: TriggerExportRequest,
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
  @MessagePattern(MESSAGING_ADMIN_PATTERNS.getPersonas)
  async getPersonas(
    @Payload() data: GetPersonasRequest,
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
