/**
 * Audit Trail Service
 *
 * Comprehensive audit trail management with filtering, export,
 * retention policies, and real-time alerts.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Between, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ActivityLog,
  ActivityCategory,
  ActivitySeverity,
  RetentionPolicyEntity,
  ComplianceType,
} from '../entities/security.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface AuditExportOptions {
  format: 'csv' | 'json' | 'pdf';
  tenantId?: string;
  userId?: string;
  category?: ActivityCategory;
  startDate: Date;
  endDate: Date;
  includeMetadata?: boolean;
  includeChanges?: boolean;
}

export interface AuditAlertRule {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  conditions: {
    category?: ActivityCategory[];
    severity?: ActivitySeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };
  alertChannels: ('email' | 'webhook' | 'slack' | 'sms')[];
  recipients: string[];
  cooldownMinutes: number;
  lastTriggeredAt?: Date;
}

export interface AuditSummary {
  period: {
    start: Date;
    end: Date;
  };
  totalEvents: number;
  uniqueUsers: number;
  uniqueIPs: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  criticalEvents: number;
  failedEvents: number;
  topActions: { action: string; count: number }[];
  topEntities: { type: string; count: number }[];
  anomalies: {
    type: string;
    description: string;
    count: number;
  }[];
}

export interface RetentionStats {
  totalLogs: number;
  activeLogs: number;
  archivedLogs: number;
  oldestLog: Date | null;
  newestLog: Date | null;
  storageEstimateMB: number;
  byCategory: Record<string, { active: number; archived: number }>;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class AuditTrailService {
  private readonly logger = new Logger(AuditTrailService.name);
  private alertRules: AuditAlertRule[] = [];

  constructor(
    @InjectRepository(ActivityLog)
    private readonly activityRepository: Repository<ActivityLog>,
    @InjectRepository(RetentionPolicyEntity)
    private readonly retentionRepository: Repository<RetentionPolicyEntity>,
  ) {
    this.initializeDefaultAlertRules();
  }

  // ============================================================================
  // Alert Rules Initialization
  // ============================================================================

  private initializeDefaultAlertRules(): void {
    this.alertRules = [
      {
        id: 'critical-security',
        name: 'Critical Security Events',
        description: 'Alert on critical security events',
        isActive: true,
        conditions: {
          category: ['security_event'],
          severity: ['critical'],
        },
        alertChannels: ['email', 'slack'],
        recipients: ['security@company.com'],
        cooldownMinutes: 0, // No cooldown for critical
      },
      {
        id: 'failed-logins',
        name: 'Multiple Failed Logins',
        description: 'Alert when failed login threshold exceeded',
        isActive: true,
        conditions: {
          category: ['authentication'],
          actions: ['login_failed'],
          failureOnly: true,
        },
        alertChannels: ['email'],
        recipients: ['security@company.com'],
        cooldownMinutes: 15,
      },
      {
        id: 'data-deletion',
        name: 'Mass Data Deletion',
        description: 'Alert on bulk data deletions',
        isActive: true,
        conditions: {
          actions: ['delete_', 'bulk_delete'],
        },
        alertChannels: ['email', 'slack'],
        recipients: ['admin@company.com'],
        cooldownMinutes: 30,
      },
      {
        id: 'config-changes',
        name: 'Configuration Changes',
        description: 'Alert on system configuration changes',
        isActive: true,
        conditions: {
          category: ['configuration'],
        },
        alertChannels: ['email'],
        recipients: ['admin@company.com'],
        cooldownMinutes: 60,
      },
      {
        id: 'privilege-escalation',
        name: 'Privilege Escalation',
        description: 'Alert on role/permission changes',
        isActive: true,
        conditions: {
          entityTypes: ['role', 'permission', 'user_role'],
          actions: ['update_', 'create_', 'assign_'],
        },
        alertChannels: ['email', 'slack'],
        recipients: ['security@company.com'],
        cooldownMinutes: 0,
      },
    ];
  }

  // ============================================================================
  // Audit Trail Query
  // ============================================================================

  /**
   * Get audit trail with advanced filtering
   */
  async getAuditTrail(options: {
    page?: number;
    limit?: number;
    tenantId?: string;
    userId?: string;
    userEmail?: string;
    category?: ActivityCategory;
    severity?: ActivitySeverity[];
    actions?: string[];
    entityType?: string;
    entityId?: string;
    ipAddress?: string;
    success?: boolean;
    startDate?: Date;
    endDate?: Date;
    searchQuery?: string;
    tags?: string[];
    includeArchived?: boolean;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<{
    data: ActivityLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 50,
      tenantId,
      userId,
      userEmail,
      category,
      severity,
      actions,
      entityType,
      entityId,
      ipAddress,
      success,
      startDate,
      endDate,
      searchQuery,
      tags,
      includeArchived = false,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const qb = this.activityRepository.createQueryBuilder('log');

    // Basic filters
    if (tenantId) qb.andWhere('log.tenantId = :tenantId', { tenantId });
    if (userId) qb.andWhere('log.userId = :userId', { userId });
    if (userEmail) qb.andWhere('log.userEmail = :userEmail', { userEmail });
    if (category) qb.andWhere('log.category = :category', { category });
    if (entityType) qb.andWhere('log.entityType = :entityType', { entityType });
    if (entityId) qb.andWhere('log.entityId = :entityId', { entityId });
    if (ipAddress) qb.andWhere('log.ipAddress = :ipAddress', { ipAddress });
    if (success !== undefined) qb.andWhere('log.success = :success', { success });

    // Date range
    if (startDate) qb.andWhere('log.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('log.createdAt <= :endDate', { endDate });

    // Severity filter (multiple values)
    if (severity && severity.length > 0) {
      qb.andWhere('log.severity IN (:...severity)', { severity });
    }

    // Action filter (pattern matching)
    if (actions && actions.length > 0) {
      const actionConditions = actions.map((a, i) => `log.action LIKE :action${i}`);
      const actionParams = actions.reduce((acc, a, i) => {
        acc[`action${i}`] = `%${a}%`;
        return acc;
      }, {} as Record<string, string>);
      qb.andWhere(`(${actionConditions.join(' OR ')})`, actionParams);
    }

    // Full-text search
    if (searchQuery) {
      qb.andWhere(
        `(log.description ILIKE :search OR log.userName ILIKE :search OR log.entityName ILIKE :search OR log.action ILIKE :search)`,
        { search: `%${searchQuery}%` },
      );
    }

    // Tag filter
    if (tags && tags.length > 0) {
      qb.andWhere('log.tags && ARRAY[:...tags]::varchar[]', { tags });
    }

    // Archive filter
    if (!includeArchived) {
      qb.andWhere('log.isArchived = :isArchived', { isArchived: false });
    }

    // Sorting and pagination
    qb.orderBy(`log.${sortBy}`, sortOrder);
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Get audit summary for a period
   */
  async getAuditSummary(options: {
    tenantId?: string;
    startDate: Date;
    endDate: Date;
  }): Promise<AuditSummary> {
    const { tenantId, startDate, endDate } = options;

    try {
      const baseWhere = tenantId
        ? { tenantId, createdAt: Between(startDate, endDate) }
        : { createdAt: Between(startDate, endDate) };

    // Total events
    const totalEvents = await this.activityRepository.count({
      where: baseWhere,
    });

    // Unique users
    const uniqueUsersResult = await this.activityRepository
      .createQueryBuilder('log')
      .select('COUNT(DISTINCT log.userId)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .getRawOne();
    const uniqueUsers = parseInt(uniqueUsersResult?.count || '0', 10);

    // Unique IPs
    const uniqueIPsResult = await this.activityRepository
      .createQueryBuilder('log')
      .select('COUNT(DISTINCT log.ipAddress)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .getRawOne();
    const uniqueIPs = parseInt(uniqueIPsResult?.count || '0', 10);

    // By category
    const categoryStats = await this.activityRepository
      .createQueryBuilder('log')
      .select('log.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .groupBy('log.category')
      .getRawMany();

    const byCategory: Record<string, number> = {};
    categoryStats.forEach((s) => {
      byCategory[s.category] = parseInt(s.count, 10);
    });

    // By severity
    const severityStats = await this.activityRepository
      .createQueryBuilder('log')
      .select('log.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .groupBy('log.severity')
      .getRawMany();

    const bySeverity: Record<string, number> = {};
    severityStats.forEach((s) => {
      bySeverity[s.severity] = parseInt(s.count, 10);
    });

    // Critical and failed events
    const criticalEvents = await this.activityRepository.count({
      where: { ...baseWhere, severity: 'critical' as ActivitySeverity },
    });

    const failedEvents = await this.activityRepository.count({
      where: { ...baseWhere, success: false },
    });

    // Top actions
    const topActions = await this.activityRepository
      .createQueryBuilder('log')
      .select('log.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .groupBy('log.action')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Top entity types
    const topEntities = await this.activityRepository
      .createQueryBuilder('log')
      .select('log.entityType', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere('log.entityType IS NOT NULL')
      .groupBy('log.entityType')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Detect anomalies
    const anomalies = await this.detectAnomalies(tenantId, startDate, endDate);

    return {
      period: { start: startDate, end: endDate },
      totalEvents,
      uniqueUsers,
      uniqueIPs,
      byCategory,
      bySeverity,
      criticalEvents,
      failedEvents,
      topActions: topActions.map((a) => ({
        action: a.action,
        count: parseInt(a.count, 10),
      })),
      topEntities: topEntities.map((e) => ({
        type: e.type,
        count: parseInt(e.count, 10),
      })),
      anomalies,
    };
    } catch (error) {
      // Return empty summary on error to prevent 500
      this.logger.error('Error fetching audit summary:', error);
      return {
        period: { start: startDate, end: endDate },
        totalEvents: 0,
        uniqueUsers: 0,
        uniqueIPs: 0,
        byCategory: {},
        bySeverity: {},
        criticalEvents: 0,
        failedEvents: 0,
        topActions: [],
        topEntities: [],
        anomalies: [],
      };
    }
  }

  /**
   * Detect anomalies in audit data
   */
  private async detectAnomalies(
    tenantId: string | undefined,
    startDate: Date,
    endDate: Date,
  ): Promise<{ type: string; description: string; count: number }[]> {
    const anomalies: { type: string; description: string; count: number }[] = [];

    // Unusual hours activity (outside 6am-10pm)
    const offHoursActivity = await this.activityRepository
      .createQueryBuilder('log')
      .select('COUNT(*)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere('EXTRACT(HOUR FROM log.createdAt) NOT BETWEEN 6 AND 22')
      .getRawOne();

    const offHoursCount = parseInt(offHoursActivity?.count || '0', 10);
    if (offHoursCount > 100) {
      anomalies.push({
        type: 'off_hours_activity',
        description: 'Significant activity detected outside normal business hours',
        count: offHoursCount,
      });
    }

    // High failure rate
    const totalEvents = await this.activityRepository.count({
      where: tenantId
        ? { tenantId, createdAt: Between(startDate, endDate) }
        : { createdAt: Between(startDate, endDate) },
    });

    const failedEvents = await this.activityRepository.count({
      where: tenantId
        ? { tenantId, success: false, createdAt: Between(startDate, endDate) }
        : { success: false, createdAt: Between(startDate, endDate) },
    });

    const failureRate = totalEvents > 0 ? (failedEvents / totalEvents) * 100 : 0;
    if (failureRate > 10) {
      anomalies.push({
        type: 'high_failure_rate',
        description: `High failure rate detected: ${failureRate.toFixed(1)}%`,
        count: failedEvents,
      });
    }

    // Unusual IP concentration
    const ipConcentration = await this.activityRepository
      .createQueryBuilder('log')
      .select('log.ipAddress', 'ip')
      .addSelect('COUNT(*)', 'count')
      .where('log.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere(tenantId ? 'log.tenantId = :tenantId' : '1=1', { tenantId })
      .groupBy('log.ipAddress')
      .having('COUNT(*) > :threshold', { threshold: totalEvents * 0.3 })
      .getRawMany();

    if (ipConcentration.length > 0) {
      anomalies.push({
        type: 'ip_concentration',
        description: `${ipConcentration.length} IP(s) account for >30% of all activity`,
        count: ipConcentration.reduce((sum, i) => sum + parseInt(i.count, 10), 0),
      });
    }

    return anomalies;
  }

  // ============================================================================
  // Export
  // ============================================================================

  /**
   * Export audit trail
   */
  async exportAuditTrail(options: AuditExportOptions): Promise<{
    data: string;
    filename: string;
    mimeType: string;
  }> {
    const { format, tenantId, userId, category, startDate, endDate, includeMetadata, includeChanges } = options;

    const where: Record<string, unknown> = {
      createdAt: Between(startDate, endDate),
    };
    if (tenantId) where.tenantId = tenantId;
    if (userId) where.userId = userId;
    if (category) where.category = category;

    const logs = await this.activityRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: 100000, // Max 100k records per export
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    switch (format) {
      case 'csv':
        return {
          data: this.convertToCSV(logs, includeMetadata, includeChanges),
          filename: `audit-trail-${timestamp}.csv`,
          mimeType: 'text/csv',
        };
      case 'json':
        return {
          data: JSON.stringify(logs, null, 2),
          filename: `audit-trail-${timestamp}.json`,
          mimeType: 'application/json',
        };
      case 'pdf':
        // PDF generation would require a library like pdfkit
        return {
          data: this.generatePDFPlaceholder(logs),
          filename: `audit-trail-${timestamp}.pdf`,
          mimeType: 'application/pdf',
        };
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Convert logs to CSV format
   */
  private convertToCSV(
    logs: ActivityLog[],
    includeMetadata?: boolean,
    includeChanges?: boolean,
  ): string {
    const headers = [
      'ID',
      'Timestamp',
      'Category',
      'Severity',
      'Action',
      'Description',
      'User ID',
      'User Name',
      'User Email',
      'Tenant ID',
      'Tenant Name',
      'Entity Type',
      'Entity ID',
      'Entity Name',
      'IP Address',
      'Success',
      'Error Message',
      'Duration (ms)',
    ];

    if (includeMetadata) {
      headers.push('Metadata');
    }
    if (includeChanges) {
      headers.push('Previous Value', 'New Value', 'Changed Fields');
    }

    const rows = logs.map((log) => {
      const row = [
        log.id,
        log.createdAt.toISOString(),
        log.category,
        log.severity,
        log.action,
        `"${log.description.replace(/"/g, '""')}"`,
        log.userId || '',
        log.userName || '',
        log.userEmail || '',
        log.tenantId || '',
        log.tenantName || '',
        log.entityType || '',
        log.entityId || '',
        log.entityName || '',
        log.ipAddress,
        log.success ? 'Yes' : 'No',
        log.errorMessage || '',
        log.duration?.toString() || '',
      ];

      if (includeMetadata) {
        row.push(log.metadata ? JSON.stringify(log.metadata) : '');
      }
      if (includeChanges) {
        row.push(
          log.previousValue ? JSON.stringify(log.previousValue) : '',
          log.newValue ? JSON.stringify(log.newValue) : '',
          log.changedFields ? log.changedFields.join(', ') : '',
        );
      }

      return row.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Generate PDF placeholder (actual implementation would use pdfkit)
   */
  private generatePDFPlaceholder(logs: ActivityLog[]): string {
    // In production, this would use pdfkit or similar
    return `PDF Export - ${logs.length} audit entries`;
  }

  // ============================================================================
  // Retention Policies
  // ============================================================================

  /**
   * Get all retention policies
   */
  async getRetentionPolicies(): Promise<RetentionPolicyEntity[]> {
    return this.retentionRepository.find({
      order: { category: 'ASC' },
    });
  }

  /**
   * Get retention policy by ID
   */
  async getRetentionPolicy(id: string): Promise<RetentionPolicyEntity> {
    const policy = await this.retentionRepository.findOne({ where: { id } });
    if (!policy) {
      throw new NotFoundException(`Retention policy not found: ${id}`);
    }
    return policy;
  }

  /**
   * Create retention policy
   */
  async createRetentionPolicy(data: {
    name: string;
    category: ActivityCategory;
    description?: string;
    retentionDays: number;
    archiveAfterDays?: number;
    deleteAfterArchiveDays?: number;
    isGlobal?: boolean;
    specificTenants?: string[];
    complianceFrameworks?: ComplianceType[];
    createdBy: string;
  }): Promise<RetentionPolicyEntity> {
    const policy = this.retentionRepository.create({
      name: data.name,
      category: data.category,
      description: data.description || null,
      retentionDays: data.retentionDays,
      archiveAfterDays: data.archiveAfterDays || null,
      deleteAfterArchiveDays: data.deleteAfterArchiveDays || null,
      isGlobal: data.isGlobal ?? true,
      specificTenants: data.specificTenants || null,
      complianceFrameworks: data.complianceFrameworks || null,
      isActive: true,
      createdBy: data.createdBy,
    });

    return this.retentionRepository.save(policy);
  }

  /**
   * Update retention policy
   */
  async updateRetentionPolicy(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      retentionDays: number;
      archiveAfterDays: number;
      deleteAfterArchiveDays: number;
      isGlobal: boolean;
      specificTenants: string[];
      complianceFrameworks: ComplianceType[];
      isActive: boolean;
    }>,
    updatedBy: string,
  ): Promise<RetentionPolicyEntity> {
    const policy = await this.getRetentionPolicy(id);
    Object.assign(policy, data, { updatedBy });
    return this.retentionRepository.save(policy);
  }

  /**
   * Delete retention policy
   */
  async deleteRetentionPolicy(id: string): Promise<void> {
    await this.retentionRepository.delete({ id });
  }

  /**
   * Get retention statistics
   */
  async getRetentionStats(): Promise<RetentionStats> {
    const totalLogs = await this.activityRepository.count();
    const archivedLogs = await this.activityRepository.count({ where: { isArchived: true } });
    const activeLogs = totalLogs - archivedLogs;

    const oldestLog = await this.activityRepository.findOne({
      order: { createdAt: 'ASC' },
      select: ['createdAt'],
    });

    const newestLog = await this.activityRepository.findOne({
      order: { createdAt: 'DESC' },
      select: ['createdAt'],
    });

    // Estimate storage (rough calculation)
    const avgRecordSizeBytes = 2000; // Estimated average
    const storageEstimateMB = (totalLogs * avgRecordSizeBytes) / (1024 * 1024);

    // By category
    const categoryStats = await this.activityRepository
      .createQueryBuilder('log')
      .select('log.category', 'category')
      .addSelect('log.isArchived', 'isArchived')
      .addSelect('COUNT(*)', 'count')
      .groupBy('log.category')
      .addGroupBy('log.isArchived')
      .getRawMany();

    const byCategory: Record<string, { active: number; archived: number }> = {};
    categoryStats.forEach((s) => {
      const cat = s.category as string;
      if (!byCategory[cat]) {
        byCategory[cat] = { active: 0, archived: 0 };
      }
      const catEntry = byCategory[cat];
      if (catEntry) {
        if (s.isArchived === true || s.isArchived === 'true') {
          catEntry.archived = parseInt(s.count, 10);
        } else {
          catEntry.active = parseInt(s.count, 10);
        }
      }
    });

    return {
      totalLogs,
      activeLogs,
      archivedLogs,
      oldestLog: oldestLog?.createdAt || null,
      newestLog: newestLog?.createdAt || null,
      storageEstimateMB: Math.round(storageEstimateMB * 100) / 100,
      byCategory,
    };
  }

  /**
   * Apply retention policies
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async applyRetentionPolicies(): Promise<void> {
    this.logger.log('Applying retention policies...');

    const policies = await this.retentionRepository.find({
      where: { isActive: true },
    });

    for (const policy of policies) {
      await this.applyRetentionPolicy(policy);
    }

    this.logger.log('Retention policies applied successfully');
  }

  /**
   * Apply a single retention policy
   */
  private async applyRetentionPolicy(policy: RetentionPolicyEntity): Promise<void> {
    const now = new Date();

    // Archive logs
    if (policy.archiveAfterDays) {
      const archiveDate = new Date(now);
      archiveDate.setDate(archiveDate.getDate() - policy.archiveAfterDays);

      const qb = this.activityRepository
        .createQueryBuilder()
        .update(ActivityLog)
        .set({ isArchived: true, archivedAt: now })
        .where('category = :category', { category: policy.category })
        .andWhere('createdAt < :archiveDate', { archiveDate })
        .andWhere('isArchived = :isArchived', { isArchived: false });

      if (!policy.isGlobal && policy.specificTenants?.length) {
        qb.andWhere('tenantId IN (:...tenants)', { tenants: policy.specificTenants });
      }

      const result = await qb.execute();
      if (result.affected && result.affected > 0) {
        this.logger.log(`Archived ${result.affected} logs for policy: ${policy.name}`);
      }
    }

    // Delete archived logs
    if (policy.deleteAfterArchiveDays) {
      const deleteDate = new Date(now);
      deleteDate.setDate(deleteDate.getDate() - policy.deleteAfterArchiveDays);

      const qb = this.activityRepository
        .createQueryBuilder()
        .delete()
        .from(ActivityLog)
        .where('category = :category', { category: policy.category })
        .andWhere('isArchived = :isArchived', { isArchived: true })
        .andWhere('archivedAt < :deleteDate', { deleteDate });

      if (!policy.isGlobal && policy.specificTenants?.length) {
        qb.andWhere('tenantId IN (:...tenants)', { tenants: policy.specificTenants });
      }

      const result = await qb.execute();
      if (result.affected && result.affected > 0) {
        this.logger.log(`Deleted ${result.affected} archived logs for policy: ${policy.name}`);
      }
    }
  }

  // ============================================================================
  // Real-time Alerts
  // ============================================================================

  /**
   * Get alert rules
   */
  getAlertRules(): AuditAlertRule[] {
    return this.alertRules;
  }

  /**
   * Update alert rule
   */
  updateAlertRule(id: string, updates: Partial<AuditAlertRule>): AuditAlertRule | null {
    const index = this.alertRules.findIndex((r) => r.id === id);
    if (index === -1) return null;

    const existingRule = this.alertRules[index];
    if (!existingRule) return null;
    const updatedRule: AuditAlertRule = { ...existingRule, ...updates };
    this.alertRules[index] = updatedRule;
    return updatedRule;
  }

  /**
   * Create alert rule
   */
  createAlertRule(rule: Omit<AuditAlertRule, 'id'>): AuditAlertRule {
    const newRule: AuditAlertRule = {
      id: `rule-${Date.now()}`,
      name: rule.name,
      description: rule.description,
      isActive: rule.isActive,
      conditions: rule.conditions,
      alertChannels: rule.alertChannels,
      recipients: rule.recipients,
      cooldownMinutes: rule.cooldownMinutes,
      lastTriggeredAt: rule.lastTriggeredAt,
    };
    this.alertRules.push(newRule);
    return newRule;
  }

  /**
   * Delete alert rule
   */
  deleteAlertRule(id: string): boolean {
    const index = this.alertRules.findIndex((r) => r.id === id);
    if (index === -1) return false;

    this.alertRules.splice(index, 1);
    return true;
  }

  /**
   * Check if activity triggers any alert
   */
  async checkAlerts(activity: ActivityLog): Promise<void> {
    for (const rule of this.alertRules) {
      if (!rule.isActive) continue;
      if (!this.matchesRule(activity, rule)) continue;

      // Check cooldown
      if (rule.lastTriggeredAt && rule.cooldownMinutes > 0) {
        const cooldownEnd = new Date(rule.lastTriggeredAt);
        cooldownEnd.setMinutes(cooldownEnd.getMinutes() + rule.cooldownMinutes);
        if (new Date() < cooldownEnd) continue;
      }

      // Trigger alert
      await this.triggerAlert(rule, activity);
      rule.lastTriggeredAt = new Date();
    }
  }

  /**
   * Check if activity matches rule conditions
   */
  private matchesRule(activity: ActivityLog, rule: AuditAlertRule): boolean {
    const { conditions } = rule;

    if (conditions.category?.length && !conditions.category.includes(activity.category)) {
      return false;
    }

    if (conditions.severity?.length && !conditions.severity.includes(activity.severity)) {
      return false;
    }

    if (conditions.actions?.length) {
      const matches = conditions.actions.some((a) => activity.action.includes(a));
      if (!matches) return false;
    }

    if (conditions.entityTypes?.length && activity.entityType) {
      if (!conditions.entityTypes.includes(activity.entityType)) return false;
    }

    if (conditions.successOnly && !activity.success) return false;
    if (conditions.failureOnly && activity.success) return false;

    if (conditions.ipPatterns?.length) {
      const matches = conditions.ipPatterns.some((p) =>
        new RegExp(p).test(activity.ipAddress),
      );
      if (!matches) return false;
    }

    return true;
  }

  /**
   * Trigger alert
   */
  private async triggerAlert(rule: AuditAlertRule, activity: ActivityLog): Promise<void> {
    this.logger.warn(`Alert triggered: ${rule.name} for activity ${activity.id}`);

    // In production, this would send actual notifications
    for (const channel of rule.alertChannels) {
      switch (channel) {
        case 'email':
          // await this.emailService.sendAlert(rule.recipients, rule, activity);
          this.logger.log(`Would send email alert to: ${rule.recipients.join(', ')}`);
          break;
        case 'slack':
          // await this.slackService.sendAlert(rule, activity);
          this.logger.log('Would send Slack alert');
          break;
        case 'webhook':
          // await this.webhookService.sendAlert(rule, activity);
          this.logger.log('Would trigger webhook');
          break;
        case 'sms':
          // await this.smsService.sendAlert(rule.recipients, rule, activity);
          this.logger.log(`Would send SMS alert to: ${rule.recipients.join(', ')}`);
          break;
      }
    }
  }
}
