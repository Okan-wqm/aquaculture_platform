import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

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
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Persist an audit-log row.
   *
   * # Why the optional EntityManager (SEC-MEDIUM-002 / FINDING #5)
   *
   * WHAT: when a caller passes the `manager` from an enclosing
   * `dataSource.transaction(manager => ...)` block, the audit row is
   * written on THAT transaction's connection via the EntityManager's
   * entity-target `create`/`save` (no repository handle). When omitted,
   * it falls back to the injected repository's own manager — behaviour
   * identical to the previous single-connection implementation.
   *
   * WHY: the role-mutation tx blocks in tenant-user-management assert
   * fail-CLOSED audit (audit must roll back with the mutation). Before
   * this overload `log()` always saved on a SEPARATE connection, so a
   * rolled-back role change still left an orphan audit row (fail-OPEN).
   * Threading the caller's `manager` makes the audit write atomic with
   * the mutation. `AuditLog` is `@Entity('audit_logs', { schema: 'auth' })`,
   * so `manager.create(AuditLog, ...)` routes the write to
   * `auth.audit_logs` inside the passed transaction.
   */
  async log(
    dto: CreateAuditLogDto,
    // Narrowed to the exact EntityManager surface this method uses (entity-target
    // create/save) so a transaction manager threads in without a cast and the
    // test double needs no `as`. A real EntityManager satisfies this.
    manager?: Pick<EntityManager, 'create' | 'save'>,
  ): Promise<AuditLog> {
    // EntityManager.create/save (entity-target form) binds the write to the
    // caller's transaction without a repository handle — atomic/fail-CLOSED
    // audit. Pure INSERT with explicit dto.tenantId; no tenant-unscoped find.
    if (manager) {
      const auditLog = manager.create(AuditLog, {
        ...dto,
        severity: dto.severity ?? AuditLogSeverity.INFO,
      });
      const saved = await manager.save(auditLog);
      this.logger.debug(`Audit log created: ${dto.action} for ${dto.entityType}`);
      return saved;
    }

    // ORPHAN-HIGH-308 (completion) — standalone audit appends run in SYSTEM
    // context. The additive audit_append_system INSERT policy is necessary
    // but NOT sufficient: TypeORM save() always emits INSERT … RETURNING
    // (to reload generated columns), and PostgreSQL applies the SELECT
    // policy's USING clause to rows read back via RETURNING — so a
    // pre-auth/SUPER_ADMIN session (no tenant GUC) still failed with
    // "new row violates row-level security policy" AFTER the policy landed
    // (proven live 2026-07-02 18:16 UTC; probe: INSERT passes, INSERT …
    // RETURNING fails under SET ROLE auth_service). set_config with
    // is_local = true scopes the bypass to THIS transaction — the same
    // audited system primitive BypassRlsService and the outbox dispatcher
    // (ORPHAN-HIGH-321) use — so it cannot leak through the pool. Audit
    // rows are system-authored compliance records; writing them is the
    // service's own act, never a tenant-scoped read surface.
    return this.dataSource.transaction(async (txn) => {
      await txn.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const auditLog = txn.create(AuditLog, {
        ...dto,
        severity: dto.severity ?? AuditLogSeverity.INFO,
      });
      const saved = await txn.save(auditLog);
      this.logger.debug(`Audit log created: ${dto.action} for ${dto.entityType}`);
      return saved;
    });
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

    // COMPLIANCE-HIGH-001 cure: WHERE clause MUST exclude legalHold=true
    // rows. Pre-fix the cron used repository.delete({ createdAt: LessThan }),
    // which translates to a single statement-level DELETE — if ANY row in
    // the matching set had legalHold=true, the BEFORE DELETE trigger
    // (`trg_audit_logs_prevent_legal_hold_delete`) raised an exception and
    // aborted the ENTIRE statement, leaking 0 rows deleted PLUS a per-cycle
    // exception in the logs. The trigger is defense-in-depth, not the
    // primary filter.
    //
    // QueryBuilder is required because TypeORM's repository.delete shorthand
    // doesn't compose `LessThan` AND `Equal(false)` on different columns into
    // the same WHERE — the literal { createdAt: LessThan, legalHold: false }
    // form treats it as separate criteria but TypeORM still emits a single
    // statement, which is what we want — but switching to QueryBuilder makes
    // the SQL shape explicit and reviewable.
    const result = await this.auditLogRepository
      .createQueryBuilder()
      .delete()
      .where('"createdAt" < :cutoff', { cutoff: cutoffDate })
      .andWhere('"legalHold" = false')
      .execute();

    this.logger.log(`Deleted ${result.affected} old audit logs (legalHold-excluded)`);
    return result.affected || 0;
  }
}
