import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  Between,
  FindOptionsWhere,
  MoreThanOrEqual,
  LessThanOrEqual,
} from 'typeorm';

import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

import { AuditAction, AuditLog, AuditSeverity } from './audit.entity';

export interface AuditLogInput {
  action: AuditAction;
  entityType: string;
  entityId?: string;
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  severity?: AuditSeverity;
  requestId?: string;
  sessionId?: string;
}

/**
 * What `GET /security/audit/summary` returns.
 *
 * Named rather than inline so the admin panel can DERIVE it. It was anonymous
 * on both the service and the controller, so the panel had to re-declare it —
 * and it did so under the name `AuditSummary`, which a different type in
 * `security/services/audit-trail.service.ts` already owns. Two unrelated shapes
 * sharing one name is how a generator gets pointed at the wrong one and emits a
 * contract that compiles and lies.
 */
export interface AuditStatistics {
  totalLogs: number;
  last24Hours: number;
  byAction: Array<{ action: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  byEntityType: Array<{ entityType: string; count: number }>;
  topUsers: Array<{ userId: string; email: string; count: number }>;
}

export interface AuditLogFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  performedBy?: string;
  performedByEmail?: string;
  severity?: AuditSeverity;
  startDate?: Date;
  endDate?: Date;
  search?: string;
}

interface ActionCountRow {
  action?: string | null;
  count: string;
}

interface SeverityCountRow {
  severity?: string | null;
  count: string;
}

interface EntityTypeCountRow {
  entityType?: string | null;
  count: string;
}

interface UserCountRow {
  userId?: string | null;
  email?: string | null;
  count: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * Log an audit event
   */
  async log(input: AuditLogInput): Promise<AuditLog | null> {
    try {
      const auditLog = this.auditLogRepository.create({
        ...input,
        severity: input.severity || this.determineSeverity(input.action),
      });

      const savedLog = await this.auditLogRepository.save(auditLog);

      this.logger.debug(
        `Audit log created: ${input.action} by ${input.performedBy}`,
      );

      return savedLog;
    } catch (error) {
      // BUG-029 fix: return null instead of an unsaved entity that callers
      // may mistakenly treat as persisted (e.g., checking .id for existence).
      // Don't throw - audit logging should not break main operations.
      this.logger.error(
        `Failed to create audit log: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return null;
    }
  }

  /**
   * Query audit logs with filtering and pagination
   */
  async query(
    filter: AuditLogFilter,
    page = 1,
    limit = 50,
  ): Promise<IStandardPaginatedResult<AuditLog>> {
    try {
      const skip = (page - 1) * limit;
      const take = Math.min(limit, 100);

      const queryBuilder = this.auditLogRepository
        .createQueryBuilder('audit')
        .orderBy('audit.createdAt', 'DESC');

      if (filter.action) {
        queryBuilder.andWhere('audit.action = :action', { action: filter.action });
      }

      if (filter.entityType) {
        queryBuilder.andWhere('audit.entityType = :entityType', {
          entityType: filter.entityType,
        });
      }

      if (filter.entityId) {
        queryBuilder.andWhere('audit.entityId = :entityId', {
          entityId: filter.entityId,
        });
      }

      if (filter.tenantId) {
        queryBuilder.andWhere('audit.tenantId = :tenantId', {
          tenantId: filter.tenantId,
        });
      }

      if (filter.performedBy) {
        queryBuilder.andWhere('audit.performedBy = :performedBy', {
          performedBy: filter.performedBy,
        });
      }

      if (filter.performedByEmail) {
        queryBuilder.andWhere('audit.performedByEmail = :performedByEmail', {
          performedByEmail: filter.performedByEmail,
        });
      }

      if (filter.severity) {
        queryBuilder.andWhere('audit.severity = :severity', {
          severity: filter.severity,
        });
      }

      if (filter.startDate) {
        queryBuilder.andWhere('audit.createdAt >= :startDate', {
          startDate: filter.startDate,
        });
      }

      if (filter.endDate) {
        queryBuilder.andWhere('audit.createdAt <= :endDate', {
          endDate: filter.endDate,
        });
      }

      if (filter.search) {
        // MED-006 fix: restrict search to safe, non-sensitive indexed fields only.
        // Casting details::text was allowing substring matches against JSONB blobs that
        // may contain PII, API keys, or other sensitive data stored in audit entries.
        queryBuilder.andWhere(
          '(audit.action ILIKE :search OR audit.entityType ILIKE :search OR audit.entityId ILIKE :search)',
          { search: `%${filter.search}%` },
        );
      }

      queryBuilder.skip(skip).take(take);

      const [data, total] = await queryBuilder.getManyAndCount();

      return createStandardPaginatedResult(data, total, page, take);
    } catch (error) {
      this.logger.error(
        `Failed to query audit logs: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return createStandardPaginatedResult<AuditLog>([], 0, page, Math.min(limit, 100));
    }
  }

  /**
   * Get audit logs for a specific entity
   */
  async getEntityHistory(
    entityType: string,
    entityId: string,
    limit = 100,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { entityType, entityId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get audit logs for a specific user's actions
   */
  async getUserActivity(
    userId: string,
    startDate?: Date,
    endDate?: Date,
    limit = 100,
  ): Promise<AuditLog[]> {
    const where: FindOptionsWhere<AuditLog> = { performedBy: userId };

    if (startDate && endDate) {
      where.createdAt = Between(startDate, endDate);
    } else if (startDate) {
      where.createdAt = MoreThanOrEqual(startDate);
    } else if (endDate) {
      where.createdAt = LessThanOrEqual(endDate);
    }

    return this.auditLogRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get security-related audit logs.
   *
   * # Cross-tenant semantics
   *
   * When `tenantId` is supplied, the query is scoped to that tenant.
   * When omitted, the call returns security events platform-wide across
   * EVERY tenant. Cross-tenant read is intentional for SUPER_ADMIN
   * platform-level security dashboards, and is safe here because:
   *
   *   1. Access is gated by `PlatformAdminGuard` at the global APP_GUARD
   *      level (apps/admin-api-service/src/app.module.ts:254-263) — every
   *      endpoint in admin-api-service requires SUPER_ADMIN role.
   *
   *   2. `AdminBypassRlsInterceptor` wraps every admin-api request in
   *      `BypassRlsService.withBypass()`, which sets `app.bypass_rls = 'on'`
   *      on the connection. RLS policy lets the query see cross-tenant
   *      rows only under this explicit bypass — which is audit-logged
   *      (WARN level, `RLS BYPASS GRANTED`) for compliance review.
   *
   *   3. The caller (audit.controller.ts) also writes a meta-audit entry
   *      via `writeMetaAudit()` so there's a second trail recording
   *      "admin X queried audit logs at time T with filter F".
   *
   * If a caller wants EXPLICIT platform-wide semantics to avoid the
   * "tenantId accidentally undefined" footgun, pass `null` or `undefined`
   * deliberately — the meta-audit entry records the absence.
   */
  async getSecurityLogs(
    tenantId?: string,
    limit = 100,
  ): Promise<AuditLog[]> {
    const securityActions = [
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'LOGOUT',
      'TOKEN_REVOKED',
      'PERMISSION_DENIED',
      'SUSPICIOUS_ACTIVITY',
      'USER_PASSWORD_RESET',
      'USER_LOCKED',
      'USER_UNLOCKED',
      'USER_IMPERSONATED',
    ];

    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('audit')
      .where('audit.action IN (:...actions)', { actions: securityActions })
      .orderBy('audit.createdAt', 'DESC')
      .take(limit);

    if (tenantId) {
      queryBuilder.andWhere('audit.tenantId = :tenantId', { tenantId });
    } else {
      // Explicit platform-wide branch. No WHERE clause on tenantId is
      // intentional — documented in the JSDoc above. The `1=1`-style
      // implicit case has been replaced with this explicit branch so a
      // reader cannot mistake it for a missing filter.
      this.logger?.debug(
        'getSecurityLogs called without tenantId — returning platform-wide results (SUPER_ADMIN context required; bypass audited by AdminBypassRlsInterceptor)',
      );
    }

    return queryBuilder.getMany();
  }

  /**
   * Get audit log statistics
   * Returns data in format expected by frontend admin panel
   */
  async getStatistics(
    tenantId?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<AuditStatistics> {
    // Calculate date for last 24 hours
    const last24HoursDate = new Date();
    last24HoursDate.setHours(last24HoursDate.getHours() - 24);

    // Build base where clause.
    //
    // `1=1` when tenantId is absent is an EXPLICIT platform-wide branch
    // — see getSecurityLogs() JSDoc above for the cross-tenant
    // authorisation model (PlatformAdminGuard + AdminBypassRlsInterceptor).
    // The literal is used instead of an empty string because TypeORM's
    // `andWhere('')` does not no-op cleanly — a truthy placeholder is
    // needed so subsequent `andWhere(dateWhere)` chains compose.
    // WHY: DO NOT remove this comment without updating the getSecurityLogs
    // docblock too; they are co-load-bearing in review.
    const baseWhere = tenantId ? 'audit.tenantId = :tenantId' : '1=1';
    const baseParams = tenantId ? { tenantId } : {};

    // Build date range where clause
    let dateWhere = '';
    const dateParams: Record<string, Date> = {};
    if (startDate) {
      dateWhere += ' AND audit.createdAt >= :startDate';
      dateParams['startDate'] = startDate;
    }
    if (endDate) {
      dateWhere += ' AND audit.createdAt <= :endDate';
      dateParams['endDate'] = endDate;
    }

    const [
      totalLogs,
      last24Hours,
      byActionResults,
      bySeverityResults,
      byEntityTypeResults,
      topUsersResults,
    ] = await Promise.all([
      // Total logs count
      this.auditLogRepository
        .createQueryBuilder('audit')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .getCount(),

      // Last 24 hours count
      this.auditLogRepository
        .createQueryBuilder('audit')
        .where(baseWhere, baseParams)
        .andWhere('audit.createdAt >= :last24HoursDate', { last24HoursDate })
        .getCount(),

      // By action
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.action', 'action')
        .addSelect('COUNT(*)', 'count')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .groupBy('audit.action')
        .orderBy('count', 'DESC')
        .getRawMany<ActionCountRow>(),

      // By severity
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.severity', 'severity')
        .addSelect('COUNT(*)', 'count')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .groupBy('audit.severity')
        .orderBy('count', 'DESC')
        .getRawMany<SeverityCountRow>(),

      // By entity type
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.entityType', 'entityType')
        .addSelect('COUNT(*)', 'count')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .groupBy('audit.entityType')
        .orderBy('count', 'DESC')
        .getRawMany<EntityTypeCountRow>(),

      // Top users with email
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.performedBy', 'userId')
        .addSelect('audit.performedByEmail', 'email')
        .addSelect('COUNT(*)', 'count')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .groupBy('audit.performedBy')
        .addGroupBy('audit.performedByEmail')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany<UserCountRow>(),
    ]);

    // Transform results to expected format (arrays instead of objects)
    const byAction = byActionResults.map((r) => ({
      action: r.action || 'unknown',
      count: parseInt(r.count, 10),
    }));

    const bySeverity = bySeverityResults.map((r) => ({
      severity: r.severity || 'info',
      count: parseInt(r.count, 10),
    }));

    const byEntityType = byEntityTypeResults.map((r) => ({
      entityType: r.entityType || 'unknown',
      count: parseInt(r.count, 10),
    }));

    const topUsers = topUsersResults.map((r) => ({
      userId: r.userId || 'unknown',
      email: r.email || 'unknown@unknown.com',
      count: parseInt(r.count, 10),
    }));

    return {
      totalLogs,
      last24Hours,
      byAction,
      bySeverity,
      byEntityType,
      topUsers,
    };
  }

  /**
   * Immutable admin audit logs are never purged in-process.
   *
   * Retention workflows may archive or partition storage outside this service,
   * but this append-only source of truth must not issue DELETE statements.
   */
  purgeOldLogs(retentionDays: number): number {
    this.logger.warn(
      `Skipped immutable audit log purge request for retentionDays=${retentionDays}`,
    );

    return 0;
  }

  private determineSeverity(action: string): AuditSeverity {
    const criticalActions = [
      'TENANT_SUSPENDED',
      'TENANT_DEACTIVATED',
      'TENANT_ARCHIVED',
      'USER_DELETED',
      'USER_LOCKED',
      'TOKEN_REVOKED',
      'PERMISSION_DENIED',
      'SUSPICIOUS_ACTIVITY',
      'DATA_EXPORT',
    ];

    const warningActions = [
      'USER_IMPERSONATED',
      'USER_PASSWORD_RESET',
      'TENANT_TIER_CHANGED',
      'TENANT_LIMITS_UPDATED',
      'SYSTEM_SETTING_CHANGED',
      'MAINTENANCE_MODE_ENABLED',
      'LOGIN_FAILED',
    ];

    if (criticalActions.includes(action)) {
      return AuditSeverity.CRITICAL;
    }

    if (warningActions.includes(action)) {
      return AuditSeverity.WARNING;
    }

    return AuditSeverity.INFO;
  }
}
