/**
 * AuditLogService - Audit log yönetimi
 *
 * Özellikleri:
 * - Entity değişikliklerini logla
 * - Değişen alanları otomatik tespit et
 * - Retention policy uygula (90 gün)
 * - Bulk cleanup işlemi
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditLog, AuditAction, AuditChanges, AuditMetadata } from '../entities/audit-log.entity';
import { AuditRedactionService } from './audit-redaction.service';

export interface LogAuditParams {
  tenantId: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  userId?: string;
  userName?: string;
  changes?: AuditChanges;
  metadata?: AuditMetadata;
  entityVersion?: number;
  summary?: string;
}

export interface AuditLogQuery {
  tenantId: string;
  entityType?: string;
  entityId?: string;
  action?: AuditAction;
  userId?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  /**
   * Default retention period for farm-side audit rows.
   *
   * # Why 7 years
   *
   * AUDITTRAIL-HIGH-007 cure (companion to AUDITTRAIL-HIGH-001 which
   * raised auth-service to the same floor). The previous 90-day default
   * was 30x below the SOC 2 CC4 requirement of "retain audit evidence
   * for the duration of the audit window plus its proof preservation
   * period". For SOC 2 Type-II annual audits with a 12-month audit
   * window, the practical floor is 5-7 years to cover the audit +
   * dispute + appeal cycle. The previous 90-day default silently
   * destroyed evidence well before any audit cycle could surface a
   * finding.
   *
   * 7 years also satisfies:
   *   - SOX § 802 (auditor work-paper retention)
   *   - PCI-DSS § 10.7 ("at least one year, with three months
   *     immediately available for analysis"; multi-year for forensic
   *     capability)
   *   - GDPR Art 30 record-of-processing retention (no fixed statutory
   *     minimum; defensible-position window aligns with general ledger /
   *     contract retention norms)
   *   - Mattilsynet aquaculture traceability (10y record-keeping for
   *     batch / harvest data — covered by 7y floor when combined with
   *     legal-hold path for active disputes)
   *
   * # Why a build-time constant (not env-var default)
   *
   * Operators CAN override via FARM_AUDIT_LOG_RETENTION_DAYS, but the
   * floor is at the BUILD layer rather than the env layer. Previous
   * behaviour: forgetting the env var = 90 days. New behaviour:
   * forgetting the env var = 7 years. The legalHold trigger
   * (AUDITTRAIL-HIGH-005 closure on farm-side) BLOCKS the cron from
   * deleting any row that has been flagged for litigation preservation,
   * regardless of the configured retention.
   */
  private static readonly DEFAULT_RETENTION_DAYS = 7 * 365;
  private readonly redactionService: AuditRedactionService;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    // @Optional() keeps the service drop-in for unit tests that
    // construct AuditLogService with only the repository argument.
    // When DI is unavailable we fall back to a zero-config
    // AuditRedactionService instance so the redaction path is
    // NEVER bypassed — losing redaction would leak PII into the
    // audit table and defeat the GDPR posture this phase sets up.
    @Optional()
    redactionService?: AuditRedactionService,
  ) {
    this.redactionService = redactionService ?? new AuditRedactionService();
  }

  /**
   * Audit log kaydı oluştur
   *
   * Phase 2.5: changes + metadata are passed through
   * `AuditRedactionService` before the row is persisted so that
   * secrets, PII partial-masks, and oversized JSONB payloads never
   * land in `farm.farm_audit_logs`.
   */
  async log(params: LogAuditParams): Promise<AuditLog> {
    const redactedChanges = this.redactionService.redactChanges(params.changes);
    const redactedMetadata = this.redactionService.redactMetadata(params.metadata);

    const auditLog = this.auditLogRepository.create({
      tenantId: params.tenantId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      userId: params.userId,
      userName: params.userName,
      changes: redactedChanges,
      metadata: redactedMetadata,
      entityVersion: params.entityVersion,
      summary: params.summary || this.generateSummary(params),
    });

    try {
      const saved = await this.auditLogRepository.save(auditLog);
      this.logger.debug(
        `Audit log created: ${params.action} on ${params.entityType}:${params.entityId}`,
      );
      return saved;
    } catch (error) {
      // Audit log errors must not affect the main operation (fire-and-forget)
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to create audit log: ${err.message}`,
        err.stack,
      );
      return auditLog;
    }
  }

  /**
   * Entity oluşturma logu
   */
  async logCreate(
    tenantId: string,
    entityType: string,
    entityId: string,
    entity: Record<string, unknown>,
    userId?: string,
    userName?: string,
    metadata?: AuditMetadata,
  ): Promise<AuditLog> {
    return this.log({
      tenantId,
      entityType,
      entityId,
      action: AuditAction.CREATE,
      userId,
      userName,
      changes: {
        after: entity,
      },
      metadata,
      entityVersion: (entity as { version?: number }).version,
    });
  }

  /**
   * Entity güncelleme logu
   */
  async logUpdate(
    tenantId: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    userId?: string,
    userName?: string,
    metadata?: AuditMetadata,
  ): Promise<AuditLog | null> {
    const changedFields = this.getChangedFields(before, after);

    // Değişiklik yoksa log oluşturma
    if (changedFields.length === 0) {
      return null;
    }

    return this.log({
      tenantId,
      entityType,
      entityId,
      action: AuditAction.UPDATE,
      userId,
      userName,
      changes: {
        before,
        after,
        changedFields,
      },
      metadata,
      entityVersion: (after as { version?: number }).version,
    });
  }

  /**
   * Entity silme logu
   */
  async logDelete(
    tenantId: string,
    entityType: string,
    entityId: string,
    entity: Record<string, unknown>,
    userId?: string,
    userName?: string,
    metadata?: AuditMetadata,
    isSoftDelete = true,
  ): Promise<AuditLog> {
    return this.log({
      tenantId,
      entityType,
      entityId,
      action: isSoftDelete ? AuditAction.SOFT_DELETE : AuditAction.DELETE,
      userId,
      userName,
      changes: {
        before: entity,
      },
      metadata,
      entityVersion: (entity as { version?: number }).version,
    });
  }

  /**
   * Entity restore logu
   */
  async logRestore(
    tenantId: string,
    entityType: string,
    entityId: string,
    entity: Record<string, unknown>,
    userId?: string,
    userName?: string,
    metadata?: AuditMetadata,
  ): Promise<AuditLog> {
    return this.log({
      tenantId,
      entityType,
      entityId,
      action: AuditAction.RESTORE,
      userId,
      userName,
      changes: {
        after: entity,
      },
      metadata,
      entityVersion: (entity as { version?: number }).version,
    });
  }

  /**
   * Transactional variant — write the audit row through a caller-
   * supplied EntityManager so the row commits or rolls back atomically
   * with the operational change it records.
   *
   * The repository-bound `log()` is fire-and-forget and uses its own
   * connection; if the caller's transaction rolls back, the audit
   * row would still persist and lie about an event that didn't
   * actually happen. For audit trails of high-stakes operations
   * (capacity overrides, deletes, restores) the transactional
   * variant is mandatory.
   */
  async logWithManager(
    manager: EntityManager,
    params: LogAuditParams,
  ): Promise<AuditLog> {
    const redactedChanges = this.redactionService.redactChanges(params.changes);
    const redactedMetadata = this.redactionService.redactMetadata(params.metadata);

    const auditLog = manager.create(AuditLog, {
      tenantId: params.tenantId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      userId: params.userId,
      userName: params.userName,
      changes: redactedChanges,
      metadata: redactedMetadata,
      entityVersion: params.entityVersion,
      summary: params.summary || this.generateSummary(params),
    });

    // Inside a transaction we WANT failures to surface — silent swallow
    // would leave the operational write committed without its audit row.
    return manager.save(AuditLog, auditLog);
  }

  /**
   * Capacity-blocked admin-override logu.
   *
   * Recorded when an operator (SUPER_ADMIN / TENANT_ADMIN) consciously
   * placed fish into a tank that exceeded its configured biomass or
   * density cap. The TankCapacityService.enforce() call returned
   * isOverCapacity=true under 'admin-override' mode and the handler
   * persisted the over-stocking flag on the TankBatch row.
   *
   * The audit row captures *what was attempted, why the service let it
   * through, and what the post-write state looks like* — i.e. the
   * minimal information needed to trace which operator decided to
   * overstock when, by how much, and against which tank.
   *
   * `entityType` is the entity that was written under the override —
   * typically `'TankBatch'` (created/updated by allocate-to-tank or
   * transfer-batch). `changes.metadata.capacity` carries the
   * CapacityCalculation snapshot; `metadata.tankId` /
   * `metadata.equipmentId` cross-reference the tank in question.
   */
  async logCapacityBlocked(
    tenantId: string,
    entityType: string,
    entityId: string,
    capacitySnapshot: Record<string, unknown>,
    userId?: string,
    userName?: string,
    metadata?: AuditMetadata,
  ): Promise<AuditLog> {
    return this.log({
      tenantId,
      entityType,
      entityId,
      action: AuditAction.CAPACITY_BLOCKED,
      userId,
      userName,
      changes: {
        after: capacitySnapshot,
      },
      metadata,
    });
  }

  /**
   * Audit logları sorgula
   */
  async query(params: AuditLogQuery): Promise<{ data: AuditLog[]; total: number }> {
    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('audit')
      .where('audit.tenantId = :tenantId', { tenantId: params.tenantId });

    if (params.entityType) {
      queryBuilder.andWhere('audit.entityType = :entityType', {
        entityType: params.entityType,
      });
    }

    if (params.entityId) {
      queryBuilder.andWhere('audit.entityId = :entityId', {
        entityId: params.entityId,
      });
    }

    if (params.action) {
      queryBuilder.andWhere('audit.action = :action', { action: params.action });
    }

    if (params.userId) {
      queryBuilder.andWhere('audit.userId = :userId', { userId: params.userId });
    }

    if (params.fromDate) {
      queryBuilder.andWhere('audit.createdAt >= :fromDate', {
        fromDate: params.fromDate,
      });
    }

    if (params.toDate) {
      queryBuilder.andWhere('audit.createdAt <= :toDate', {
        toDate: params.toDate,
      });
    }

    const total = await queryBuilder.getCount();

    queryBuilder
      .orderBy('audit.createdAt', 'DESC')
      .skip(params.offset || 0)
      .take(params.limit || 50);

    const data = await queryBuilder.getMany();

    return { data, total };
  }

  /**
   * Entity için audit geçmişi
   */
  async getEntityHistory(
    tenantId: string,
    entityType: string,
    entityId: string,
    limit = 100,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: {
        tenantId,
        entityType,
        entityId,
      },
      order: {
        createdAt: 'DESC',
      },
      take: limit,
    });
  }

  /**
   * Retention policy cleanup. Excludes legalHold rows at the WHERE level —
   * the BEFORE DELETE trigger
   * `trg_farm_audit_logs_prevent_legal_hold_delete` (migration
   * 1788300000000) is defense-in-depth, not the primary filter. If we
   * forgot the WHERE filter, ANY held row matching the cutoff would
   * RAISE EXCEPTION and abort the entire cleanup batch — the trigger
   * fails fast (visible) instead of silently destroying held rows.
   * COMPLIANCE-HIGH-001 cure pattern.
   */
  async cleanupOldLogs(retentionDays?: number): Promise<number> {
    const days = retentionDays || AuditLogService.DEFAULT_RETENTION_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    this.logger.log(`Cleaning up audit logs older than ${days} days (before ${cutoffDate.toISOString()})`);

    const result = await this.auditLogRepository
      .createQueryBuilder()
      .delete()
      .where('"createdAt" < :cutoff', { cutoff: cutoffDate })
      .andWhere('"legalHold" = false')
      .execute();

    this.logger.log(`Deleted ${result.affected} audit log records (legalHold-excluded)`);
    return result.affected || 0;
  }

  /**
   * Değişen alanları tespit et
   */
  private getChangedFields(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string[] {
    const changedFields: string[] = [];
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    // Audit alanlarını hariç tut
    const excludedFields = ['updatedAt', 'version', 'createdAt', 'createdBy'];

    for (const key of allKeys) {
      if (excludedFields.includes(key)) continue;

      const beforeValue = before[key];
      const afterValue = after[key];

      if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
        changedFields.push(key);
      }
    }

    return changedFields;
  }

  /**
   * Özet metin oluştur
   */
  private generateSummary(params: LogAuditParams): string {
    const actionText = {
      [AuditAction.CREATE]: 'created',
      [AuditAction.UPDATE]: 'updated',
      [AuditAction.DELETE]: 'deleted',
      [AuditAction.SOFT_DELETE]: 'soft deleted',
      [AuditAction.RESTORE]: 'restored',
      [AuditAction.CAPACITY_BLOCKED]: 'over-capacity (admin override)',
      [AuditAction.MORTALITY_RECORDED]: 'mortality recorded',
      [AuditAction.CULL_RECORDED]: 'cull recorded',
      [AuditAction.REGULATORY_SUBMITTED]: 'submitted to the regulator',
      [AuditAction.REGULATORY_FAILED]: 'regulatory submission failed',
      [AuditAction.REGULATORY_APPROVED]: 'regulatory draft approved',
      [AuditAction.REGULATORY_DISMISSED]: 'regulatory draft dismissed',
      [AuditAction.REGULATORY_OVERRIDDEN]: 'regulatory draft field overridden',
    };

    const changedFields = params.changes?.changedFields;
    const fieldText = changedFields?.length
      ? ` (fields: ${changedFields.join(', ')})`
      : '';

    return `${params.entityType} ${params.entityId} was ${actionText[params.action]}${fieldText}`;
  }
}
