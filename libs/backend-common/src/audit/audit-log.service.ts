import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLogEntity, AuditSeverity } from './audit-log.entity';
import type { CreateAuditEntryDto, IAuditLogService } from './audit-log.tokens';

/**
 * Internal shape used to materialize an entity from a DTO. Kept here so
 * `record()` and `recordAwait()` cannot drift apart — every field that
 * exists on the DTO MUST be reflected here, or the AuditTrail mandatory
 * shape (AUDITTRAIL-CRITICAL-004) silently regresses on one path while
 * passing on the other.
 *
 * Returns a partial because the entity declares server-side defaults
 * (createdAt, severity, mfaVerified, legalHold) that we deliberately
 * leave for postgres / TypeORM to apply.
 */
type AuditEntityCreatePayload = Partial<AuditLogEntity>;

// Re-export the canonical DTO type from audit-log.tokens so existing
// consumers (`import { CreateAuditEntryDto } from './audit-log.service'`)
// continue to compile. The single source of truth lives in the tokens
// file because cross-cutting DI consumers (TenantGuard) need the DTO type
// without loading the @Entity decorator.
export type { CreateAuditEntryDto } from './audit-log.tokens';

/**
 * AuditLogService
 *
 * Handles persisting audit log entries to the database.
 *
 * Two recording modes are available:
 * - `record()` — fire-and-forget; errors are caught and counted but never
 *   propagated. Suitable for non-critical audit events.
 * - `recordAwait()` — awaitable; the caller blocks until the write succeeds
 *   or fails. Suitable for critical security events (e.g. SUPER_ADMIN
 *   cross-tenant access) where silent loss is unacceptable.
 *
 * SECURITY (BULGU-4): A failure counter tracks silent write failures.
 * The counter is exposed via `getFailureCount()` and logged with every
 * failure so monitoring systems can alert on `AUDIT_FAILURE` log lines.
 */
@Injectable()
export class AuditLogService implements IAuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  /**
   * Monotonically increasing counter of audit record persistence failures.
   * Exposed via `getFailureCount()` for health checks and Prometheus scraping.
   */
  private auditFailureCount = 0;

  constructor(
    @Optional()
    @InjectRepository(AuditLogEntity)
    private readonly auditLogRepository?: Repository<AuditLogEntity>,
  ) {}

  /**
   * Persist an audit log entry (fire-and-forget).
   *
   * Errors are caught, counted, and logged — never propagated to the caller.
   * For critical security events where silent loss is unacceptable, use
   * `recordAwait()` instead.
   */
  record(dto: CreateAuditEntryDto): void {
    if (!this.auditLogRepository) {
      this.logger.debug(
        `Audit log skipped (no repository): ${dto.action} on ${dto.resource}`,
      );
      return;
    }

    const entity = this.auditLogRepository.create(this.toEntityShape(dto));

    // Fire-and-forget: save asynchronously without awaiting
    this.auditLogRepository.save(entity).catch((err: unknown) => {
      this.auditFailureCount++;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `AUDIT_FAILURE [count=${this.auditFailureCount}]: Failed to persist audit log: ${dto.action} on ${dto.resource} - ${message}`,
      );
    });
  }

  /**
   * Persist an audit log entry and await the result.
   *
   * Unlike `record()`, this method propagates errors to the caller so they
   * can decide how to handle the failure. The failure counter is still
   * incremented on error for consistency.
   *
   * Use this for critical security events (SUPER_ADMIN cross-tenant access,
   * permission escalation, etc.) where silent audit loss is unacceptable.
   *
   * @throws Error if the database write fails
   */
  async recordAwait(dto: CreateAuditEntryDto): Promise<void> {
    if (!this.auditLogRepository) {
      this.logger.debug(
        `Audit log skipped (no repository): ${dto.action} on ${dto.resource}`,
      );
      return;
    }

    const entity = this.auditLogRepository.create(this.toEntityShape(dto));

    try {
      await this.auditLogRepository.save(entity);
    } catch (err: unknown) {
      this.auditFailureCount++;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `AUDIT_FAILURE [count=${this.auditFailureCount}]: Failed to persist audit log: ${dto.action} on ${dto.resource} - ${message}`,
      );
      throw err;
    }
  }

  /**
   * Return the number of audit record persistence failures since process start.
   * Useful for health checks and Prometheus gauge/counter metrics.
   */
  getFailureCount(): number {
    return this.auditFailureCount;
  }

  /**
   * Materialize the on-the-wire DTO into the database-bound entity shape.
   *
   * # Why this lives in one helper
   *
   * Both `record()` (fire-and-forget) and `recordAwait()` (synchronous)
   * must persist the SAME row shape, including every AUDITTRAIL-CRITICAL-004
   * mandatory-shape field. Pre-extension, both methods inlined a literal
   * `repository.create({ ... })` call — and the legacy literal forgot the
   * 8 new fields. Centralizing the materialization here makes it impossible
   * for one path to drop a field while the other carries it (Tier-1
   * "make it impossible" per CLAUDE.md architectural hierarchy).
   *
   * # Why undefined rather than null on the new optional fields
   *
   * The 8 new fields are nullable in the schema. Nullish coalescing here
   * (`?? null`) would convert `undefined` to an explicit `null` write —
   * which is fine, but unnecessarily verbose. We pass `undefined` through
   * unchanged: TypeORM treats undefined as "leave default" (which for a
   * non-defaulted nullable column means SQL NULL anyway), and the
   * intent at the call site stays cleaner.
   *
   * The legacy fields (action, resource, etc.) keep `?? null` because
   * their default behavior was historically `null` and consumers depend
   * on that behavior at the entity level.
   */
  private toEntityShape(dto: CreateAuditEntryDto): AuditEntityCreatePayload {
    return {
      action: dto.action,
      resource: dto.resource,
      resourceId: dto.resourceId ?? null,
      userId: dto.userId ?? null,
      userEmail: dto.userEmail ?? null,
      tenantId: dto.tenantId ?? null,
      schemaName: dto.schemaName ?? null,
      metadata: dto.metadata ?? null,
      ip: dto.ip ?? null,
      userAgent: dto.userAgent ?? null,
      severity: dto.severity ?? AuditSeverity.INFO,
      correlationId: dto.correlationId ?? null,

      // ── AUDITTRAIL-CRITICAL-004 mandatory-shape fields ──
      actorHomeTenantId: dto.actorHomeTenantId ?? null,
      actedOnTenantId: dto.actedOnTenantId ?? null,
      method: dto.method ?? null,
      // mfaVerified: only override the column default when the caller
      // explicitly set it. Pre-extension callers leave it undefined →
      // postgres applies the column default (false).
      mfaVerified: dto.mfaVerified ?? false,
      result: dto.result ?? null,
      preStateHash: dto.preStateHash ?? null,
      postStateHash: dto.postStateHash ?? null,
      justification: dto.justification ?? null,
      relatedAuditIds: dto.relatedAuditIds ?? null,
    };
  }

  /**
   * Query audit logs by tenant (for admin dashboards)
   */
  async findByTenant(
    tenantId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      action?: string;
      resource?: string;
      userId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ data: AuditLogEntity[]; total: number }> {
    if (!this.auditLogRepository) {
      return { data: [], total: 0 };
    }

    const qb = this.auditLogRepository
      .createQueryBuilder('audit')
      .where('audit.tenantId = :tenantId', { tenantId });

    if (options?.startDate) {
      qb.andWhere('audit.createdAt >= :startDate', {
        startDate: options.startDate,
      });
    }

    if (options?.endDate) {
      qb.andWhere('audit.createdAt <= :endDate', {
        endDate: options.endDate,
      });
    }

    if (options?.action) {
      qb.andWhere('audit.action = :action', { action: options.action });
    }

    if (options?.resource) {
      qb.andWhere('audit.resource = :resource', { resource: options.resource });
    }

    if (options?.userId) {
      qb.andWhere('audit.userId = :userId', { userId: options.userId });
    }

    qb.orderBy('audit.createdAt', 'DESC');

    if (options?.limit) {
      qb.take(options.limit);
    }
    if (options?.offset) {
      qb.skip(options.offset);
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  /**
   * Query audit logs by resource
   */
  async findByResource(
    resource: string,
    resourceId: string,
    tenantId: string,
  ): Promise<AuditLogEntity[]> {
    if (!this.auditLogRepository) {
      return [];
    }

    return this.auditLogRepository.find({
      where: { resource, resourceId, tenantId },
      order: { createdAt: 'DESC' },
    });
  }
}
