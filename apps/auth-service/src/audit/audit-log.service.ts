import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';

import { AuditLog, AuditLogSeverity } from './audit-log.entity';

export interface CreateAuditLogDto {
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  action: string;
  entityType: string;
  entityId?: string;
  details?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  severity?: AuditLogSeverity;
  requestId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    private readonly configService: ConfigService,
  ) {}

  async log(dto: CreateAuditLogDto): Promise<AuditLog> {
    const auditLog = this.auditLogRepository.create({
      ...dto,
      severity: dto.severity ?? AuditLogSeverity.INFO,
    });
    const saved = await this.auditLogRepository.save(auditLog);
    this.logger.debug(`Audit log created: ${dto.action} for ${dto.entityType}`);
    return saved;
  }

  async findByTenant(
    tenantId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      action?: string;
      performedBy?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ data: AuditLog[]; total: number }> {
    const query = this.auditLogRepository.createQueryBuilder('audit')
      .where('audit.tenantId = :tenantId', { tenantId });

    if (options?.startDate && options?.endDate) {
      query.andWhere('audit.createdAt BETWEEN :startDate AND :endDate', {
        startDate: options.startDate,
        endDate: options.endDate,
      });
    }

    if (options?.action) {
      query.andWhere('audit.action = :action', { action: options.action });
    }

    if (options?.performedBy) {
      query.andWhere('audit.performedBy = :performedBy', { performedBy: options.performedBy });
    }

    query.orderBy('audit.createdAt', 'DESC');

    if (options?.limit) {
      query.take(options.limit);
    }

    if (options?.offset) {
      query.skip(options.offset);
    }

    const [data, total] = await query.getManyAndCount();
    return { data, total };
  }

  async findByPerformer(
    performedBy: string,
    tenantId: string,
    limit = 100,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { performedBy, tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async findByEntity(
    entityType: string,
    entityId: string,
    tenantId: string,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { entityType, entityId, tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Default retention period for auth-side audit rows.
   *
   * # Why 7 years
   *
   * AUDITTRAIL-HIGH-001 captured that the previous default (90 days)
   * was 30x below the SOC 2 CC4 requirement of "retain audit
   * evidence for the duration of the audit window plus its proof
   * preservation period". For SOC 2 Type-II annual audits with a 12-
   * month audit window, the practical floor is 5-7 years to cover
   * the audit + dispute + appeal cycle. The previous 90-day default
   * silently destroyed evidence well before any audit cycle could
   * surface a finding.
   *
   * 7 years also satisfies:
   *   - SOX § 802 (auditor work-paper retention)
   *   - PCI-DSS § 10.7 ("at least one year, with three months
   *     immediately available for analysis"; multi-year for
   *     forensic capability)
   *   - GDPR Art 30 record-of-processing retention (no fixed
   *     statutory minimum; defensible-position window aligns with
   *     general ledger / contract retention norms)
   *
   * # Why a constant (not env-var default)
   *
   * Operators CAN override via AUDIT_LOG_RETENTION_DAYS, but the
   * floor is now at the BUILD layer rather than the env layer.
   * Previous behaviour: forgetting the env var = 90 days. New
   * behaviour: forgetting the env var = 7 years. The legalHold
   * trigger (AUDITTRAIL-HIGH-005 closure on auth-side) BLOCKS
   * the cron from deleting any row that has been flagged for
   * litigation preservation, regardless of the configured retention.
   */
  private static readonly DEFAULT_RETENTION_DAYS = 7 * 365;

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduledLogCleanup(): Promise<void> {
    const retentionDays = this.configService.get<number>(
      'AUDIT_LOG_RETENTION_DAYS',
      AuditLogService.DEFAULT_RETENTION_DAYS,
    );
    const deleted = await this.deleteOldLogs(retentionDays);
    this.logger.log(
      `Scheduled audit log cleanup: deleted ${deleted} logs older than ${retentionDays} days`,
    );
  }

  async deleteOldLogs(retentionDays = AuditLogService.DEFAULT_RETENTION_DAYS): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // The DELETE is GATED by the BEFORE DELETE trigger
    // `trg_audit_logs_prevent_legal_hold_delete` installed in the
    // AuthAuditLogsImmutability migration (AUDITTRAIL-HIGH-005
    // closure). Rows with legalHold=true are silently rejected by
    // the trigger; the cron's affected-rows count therefore reflects
    // only the un-held expired rows. The trigger raises an exception
    // per row at the DB level, but TypeORM's repository.delete
    // converts it into a per-row failure that lands in result.affected
    // as the count of successful deletes only.
    const result = await this.auditLogRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    this.logger.log(`Deleted ${result.affected} old audit logs`);
    return result.affected || 0;
  }
}
