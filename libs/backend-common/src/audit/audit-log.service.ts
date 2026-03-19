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
 * All writes are fire-and-forget to avoid blocking the response pipeline.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @Optional()
    @InjectRepository(AuditLogEntity)
    private readonly auditLogRepository?: Repository<AuditLogEntity>,
  ) {}

  /**
   * Persist an audit log entry (fire-and-forget).
   * Errors are caught and logged, never propagated to the caller.
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
    this.auditLogRepository.save(entity).catch((err: Error) => {
      this.logger.error(
        `Failed to persist audit log: ${dto.action} on ${dto.resource} - ${err.message}`,
      );
    });
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
