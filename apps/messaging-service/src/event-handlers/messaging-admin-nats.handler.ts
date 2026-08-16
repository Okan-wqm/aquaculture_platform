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
import { BadRequestException, Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1,
  ADMIN_MESSAGING_RPC_SUBJECTS_V1,
  type AdminCreateLegalHoldReleaseOperationRpcV1,
  type AdminAuthorizeLegalHoldReleaseOperationRpcV1,
  type AdminGetLegalHoldReleaseOperationsRpcV1,
  type AdminLegalHoldReleaseOperationV1,
  type AdminLegalHoldV1,
  type AdminMessagingComplianceStatsV1,
  type AdminMessagingAuditPageV1,
  type AdminMessagingRetentionPolicyV1,
  type AdminMessagingRpcRequestV1,
} from '@platform/admin-http-contracts';
import { createCursorPaginationResultV1 } from '@platform/pagination-contracts';

import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { LegalHoldReleaseOperationService } from '../compliance/services/legal-hold-release-operation.service';
import {
  toAdminLegalHoldReleaseOperationV1,
  toAdminLegalHoldV1,
  toAdminMessagingRetentionPolicyV1,
} from '../compliance/services/legal-hold-release-operation.mapper';
import { RetentionPolicyService } from '../compliance/services/retention-policy.service';
import {
  type AuditLogPage,
  ComplianceAuditService,
} from '../compliance/services/compliance-audit.service';
import { DataExportService, ExportFormat } from '../compliance/services/data-export.service';
import { AiPersonasRegistryService } from '../ai/services/ai-personas-registry.service';

import { SetRetentionPolicyCommand } from '../compliance/commands/set-retention-policy.command';
import { ActivateLegalHoldCommand } from '../compliance/commands/activate-legal-hold.command';
import { GetAuditLogQuery } from '../compliance/queries/get-audit-log.query';
import { GetRetentionPoliciesQuery } from '../compliance/queries/get-retention-policies.query';
import { RetentionPolicy } from '../compliance/entities/retention-policy.entity';
import { LegalHold } from '../compliance/entities/legal-hold.entity';
import { ComplianceAction } from '../compliance/entities/compliance-audit-log.entity';

type RpcRequest<TSubject extends keyof AdminMessagingRpcRequestV1> =
  AdminMessagingRpcRequestV1[TSubject];

function parseComplianceAction(value: string | undefined): ComplianceAction | null {
  if (value === undefined) return null;
  const action = Object.values(ComplianceAction).find((candidate) => candidate === value);
  if (action !== undefined) {
    return action;
  }
  throw new BadRequestException(`Unknown compliance action: ${value}`);
}

// ── Handler ─────────────────────────────────────────────────────────────

@Controller()
export class MessagingAdminNatsHandler {
  private readonly logger = new Logger(MessagingAdminNatsHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly legalHoldService: LegalHoldService,
    private readonly legalHoldReleaseOperationService: LegalHoldReleaseOperationService,
    private readonly retentionPolicyService: RetentionPolicyService,
    private readonly auditService: ComplianceAuditService,
    private readonly exportService: DataExportService,
    private readonly personasService: AiPersonasRegistryService,
  ) {}

  // ── Compliance Stats ────────────────────────────────────────────────

  /**
   * Return compliance statistics for a tenant.
   */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.complianceStats)
  async getComplianceStats(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.complianceStats>,
  ): Promise<AdminMessagingComplianceStatsV1> {
    this.logger.debug(`Admin request: complianceStats for tenant=${data.tenantId}`);

    const [activeHolds, policies, auditLogResult] = await Promise.all([
      this.legalHoldService.getActiveHolds(data.tenantId),
      this.queryBus.execute<GetRetentionPoliciesQuery, RetentionPolicy[]>(
        new GetRetentionPoliciesQuery(data.tenantId),
      ),
      this.auditService.getAuditLog({ tenantId: data.tenantId }, 1, null),
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
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHolds)
  async getLegalHolds(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHolds>,
  ): Promise<AdminLegalHoldV1[]> {
    this.logger.debug(`Admin request: getLegalHolds for tenant=${data.tenantId}`);
    return (await this.legalHoldService.getHolds(data.tenantId)).map(toAdminLegalHoldV1);
  }

  /**
   * Create (activate) a new legal hold.
   */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHold)
  async createLegalHold(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHold>,
  ): Promise<AdminLegalHoldV1> {
    this.logger.debug(`Admin request: createLegalHold for tenant=${data.tenantId}`);

    const hold = await this.commandBus.execute<ActivateLegalHoldCommand, LegalHold>(
      new ActivateLegalHoldCommand(
        data.tenantId,
        data.userId,
        data.channelId,
        data.reason,
        data.legalMatterId,
        data.legalMatterDescription ?? null,
        data.requestedBy ?? null,
        data.expiresAt ? new Date(data.expiresAt) : null,
      ),
    );
    return toAdminLegalHoldV1(hold);
  }

  /**
   * Open a durable release operation. This does not mutate the hold.
   */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHoldReleaseOperation)
  async createLegalHoldReleaseOperation(
    @Payload() data: AdminCreateLegalHoldReleaseOperationRpcV1,
  ): Promise<AdminLegalHoldReleaseOperationV1> {
    return toAdminLegalHoldReleaseOperationV1(
      await this.legalHoldReleaseOperationService.request(data),
    );
  }

  /** Authorize and atomically execute an operation as the second admin. */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.authorizeLegalHoldReleaseOperation)
  async authorizeLegalHoldReleaseOperation(
    @Payload() data: AdminAuthorizeLegalHoldReleaseOperationRpcV1,
  ): Promise<AdminLegalHoldReleaseOperationV1> {
    return toAdminLegalHoldReleaseOperationV1(
      await this.legalHoldReleaseOperationService.authorize(data),
    );
  }

  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHoldReleaseOperations)
  async getLegalHoldReleaseOperations(
    @Payload() data: AdminGetLegalHoldReleaseOperationsRpcV1,
  ): Promise<AdminLegalHoldReleaseOperationV1[]> {
    return (await this.legalHoldReleaseOperationService.list(data.tenantId, data.status)).map(
      toAdminLegalHoldReleaseOperationV1,
    );
  }

  // ── Retention Policies ──────────────────────────────────────────────

  /**
   * Return all retention policies for a tenant.
   */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getRetentionPolicies)
  async getRetentionPolicies(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.getRetentionPolicies>,
  ): Promise<readonly AdminMessagingRetentionPolicyV1[]> {
    this.logger.debug(`Admin request: getRetentionPolicies for tenant=${data.tenantId}`);
    const policies = await this.queryBus.execute<GetRetentionPoliciesQuery, RetentionPolicy[]>(
      new GetRetentionPoliciesQuery(data.tenantId),
    );
    return policies.map(toAdminMessagingRetentionPolicyV1);
  }

  /**
   * Create or update a retention policy.
   */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.updateRetentionPolicy)
  async updateRetentionPolicy(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.updateRetentionPolicy>,
  ): Promise<AdminMessagingRetentionPolicyV1> {
    this.logger.debug(
      `Admin request: updateRetentionPolicy tenant=${data.tenantId}, days=${data.retentionDays}`,
    );

    const policy = await this.commandBus.execute<SetRetentionPolicyCommand, RetentionPolicy>(
      new SetRetentionPolicyCommand(data.tenantId, data.userId, data.channelId, data.retentionDays),
    );
    return toAdminMessagingRetentionPolicyV1(policy);
  }

  // ── Audit Log ───────────────────────────────────────────────────────

  /**
   * Return paginated compliance audit log entries.
   */
  @MessagePattern(ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1)
  async getAuditLog(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.getAuditLog>,
  ): Promise<AdminMessagingAuditPageV1> {
    this.logger.debug(`Admin request: getAuditLog for tenant=${data.tenantId}`);

    const result = await this.queryBus.execute<GetAuditLogQuery, AuditLogPage>(
      new GetAuditLogQuery(
        data.tenantId,
        Math.min(data.limit, 100),
        data.cursor ?? null,
        data.userId ?? null,
        parseComplianceAction(data.action),
        data.resourceType ?? null,
        data.startDate ? new Date(data.startDate) : null,
        data.endDate ? new Date(data.endDate) : null,
      ),
    );

    return createCursorPaginationResultV1(
      result.items.map((entry) => ({
        id: entry.id,
        tenantId: entry.tenantId,
        userId: entry.userId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        details: entry.details,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        createdAt: entry.createdAt.toISOString(),
      })),
      result.totalCount,
      result.hasMore,
      result.cursor,
    );
  }

  // ── Data Export ─────────────────────────────────────────────────────

  /**
   * Trigger a tenant-wide data export.
   */
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.triggerExport)
  async triggerExport(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.triggerExport>,
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

    const result = await this.exportService.exportTenant(data.tenantId, data.format, data.userId);

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
  @MessagePattern(ADMIN_MESSAGING_RPC_SUBJECTS_V1.getPersonas)
  async getPersonas(
    @Payload()
    data: RpcRequest<typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1.getPersonas>,
  ): Promise<
    Array<{
      id: string | null;
      name: string;
      description: string;
      icon: string;
      color: string;
      capabilities: string[];
    }>
  > {
    this.logger.debug(`Admin request: getPersonas for tenant=${data.tenantId}`);
    return this.personasService.getAvailablePersonas(data.tenantId);
  }
}
