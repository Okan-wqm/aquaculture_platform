import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  Between,
  FindOptionsWhere,
  MoreThanOrEqual,
  LessThanOrEqual,
} from 'typeorm';
import { AuditLog, AuditSeverity } from './audit.entity';

export interface AuditLogInput {
  action: string;
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

export interface AuditLogFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  performedBy?: string;
  severity?: AuditSeverity;
  startDate?: Date;
  endDate?: Date;
  search?: string;
}

export interface PaginatedAuditLogs {
  data: AuditLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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
  async log(input: AuditLogInput): Promise<AuditLog> {
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
      // Don't throw - audit logging should not break main operations
      // Return a partial log object to indicate failure but allow main operation to continue
      this.logger.error(
        `Failed to create audit log: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // Return the unsaved log object instead of throwing
      return this.auditLogRepository.create({
        ...input,
        severity: input.severity || this.determineSeverity(input.action),
      });
    }
  }

  /**
   * Query audit logs with filtering and pagination
   */
  async query(
    filter: AuditLogFilter,
    page: number = 1,
    limit: number = 50,
  ): Promise<PaginatedAuditLogs> {
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
      queryBuilder.andWhere(
        '(audit.action ILIKE :search OR audit.entityType ILIKE :search OR CAST(audit.details AS TEXT) ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    queryBuilder.skip(skip).take(take);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }

  /**
   * Get audit logs for a specific entity
   */
  async getEntityHistory(
    entityType: string,
    entityId: string,
    limit: number = 100,
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
    limit: number = 100,
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
   * Get security-related audit logs
   */
  async getSecurityLogs(
    tenantId?: string,
    limit: number = 100,
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
  ): Promise<{
    totalLogs: number;
    last24Hours: number;
    byAction: Array<{ action: string; count: number }>;
    bySeverity: Array<{ severity: string; count: number }>;
    byEntityType: Array<{ entityType: string; count: number }>;
    topUsers: Array<{ userId: string; email: string; count: number }>;
  }> {
    // Calculate date for last 24 hours
    const last24HoursDate = new Date();
    last24HoursDate.setHours(last24HoursDate.getHours() - 24);

    // Build base where clause
    const baseWhere = tenantId ? 'audit.tenantId = :tenantId' : '1=1';
    const baseParams = tenantId ? { tenantId } : {};

    // Build date range where clause
    let dateWhere = '';
    const dateParams: Record<string, Date> = {};
    if (startDate) {
      dateWhere += ' AND audit.createdAt >= :startDate';
      dateParams.startDate = startDate;
    }
    if (endDate) {
      dateWhere += ' AND audit.createdAt <= :endDate';
      dateParams.endDate = endDate;
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
        .getRawMany(),

      // By severity
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.severity', 'severity')
        .addSelect('COUNT(*)', 'count')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .groupBy('audit.severity')
        .orderBy('count', 'DESC')
        .getRawMany(),

      // By entity type
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.entityType', 'entityType')
        .addSelect('COUNT(*)', 'count')
        .where(baseWhere + dateWhere, { ...baseParams, ...dateParams })
        .groupBy('audit.entityType')
        .orderBy('count', 'DESC')
        .getRawMany(),

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
        .getRawMany(),
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
   * Delete old audit logs (for data retention)
   */
  async purgeOldLogs(retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.auditLogRepository
      .createQueryBuilder()
      .delete()
      .where('createdAt < :cutoffDate', { cutoffDate })
      .execute();

    this.logger.log(
      `Purged ${result.affected} audit logs older than ${retentionDays} days`,
    );

    return result.affected || 0;
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
