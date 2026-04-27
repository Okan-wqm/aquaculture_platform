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
import { Repository, LessThan } from 'typeorm';
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
  private readonly DEFAULT_RETENTION_DAYS = 90;
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
   * Eski audit loglarını temizle (retention policy)
   */
  async cleanupOldLogs(retentionDays?: number): Promise<number> {
    const days = retentionDays || this.DEFAULT_RETENTION_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    this.logger.log(`Cleaning up audit logs older than ${days} days (before ${cutoffDate.toISOString()})`);

    const result = await this.auditLogRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    this.logger.log(`Deleted ${result.affected} audit log records`);
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
    };

    const changedFields = params.changes?.changedFields;
    const fieldText = changedFields?.length
      ? ` (fields: ${changedFields.join(', ')})`
      : '';

    return `${params.entityType} ${params.entityId} was ${actionText[params.action]}${fieldText}`;
  }
}
