import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLogEntity, AuditSeverity } from './audit-log.entity';

/**
 * DTO for creating an audit log entry
 */
export interface CreateAuditEntryDto {
  action: string;
  resource: string;
  resourceId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  tenantId?: string | null;
  schemaName?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  severity?: AuditSeverity;
  correlationId?: string | null;
}

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
export class AuditLogService {
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

    const entity = this.auditLogRepository.create({
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
    });

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

    const entity = this.auditLogRepository.create({
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
    });

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
