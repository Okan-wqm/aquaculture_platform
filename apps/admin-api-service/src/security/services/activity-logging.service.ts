/**
 * Activity Logging Service
 *
 * Comprehensive activity logging for user actions, system events,
 * API calls, data access, and security events.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, MoreThan, In, Like } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ActivityLog,
  ActivityCategory,
  ActivitySeverity,
  GeoLocation,
  DeviceInfo,
  RequestInfo,
  LoginAttempt,
  ApiUsageLog,
  UserSession,
} from '../entities/security.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface LogActivityParams {
  category: ActivityCategory;
  action: string;
  description: string;
  severity?: ActivitySeverity;
  tenantId?: string;
  tenantName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  ipAddress: string;
  geoLocation?: GeoLocation;
  deviceInfo?: DeviceInfo;
  requestInfo?: RequestInfo;
  sessionId?: string;
  correlationId?: string;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  changedFields?: string[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  success?: boolean;
  errorMessage?: string;
  errorCode?: string;
  duration?: number;
}

export interface ActivityQueryOptions {
  page?: number;
  limit?: number;
  tenantId?: string;
  userId?: string;
  category?: ActivityCategory;
  severity?: ActivitySeverity;
  action?: string;
  entityType?: string;
  entityId?: string;
  ipAddress?: string;
  success?: boolean;
  startDate?: Date;
  endDate?: Date;
  searchQuery?: string;
  tags?: string[];
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface ActivityStats {
  totalActivities: number;
  byCategory: Record<ActivityCategory, number>;
  bySeverity: Record<ActivitySeverity, number>;
  bySuccess: { success: number; failure: number };
  topActions: { action: string; count: number }[];
  topUsers: { userId: string; userName: string; count: number }[];
  topIPs: { ip: string; count: number }[];
  activityOverTime: { date: string; count: number }[];
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class ActivityLoggingService implements OnModuleInit {
  private readonly logger = new Logger(ActivityLoggingService.name);
  private logBuffer: ActivityLog[] = [];
  private readonly BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL = 5000; // 5 seconds

  constructor(
    @InjectRepository(ActivityLog)
    private readonly activityRepository: Repository<ActivityLog>,
    @InjectRepository(LoginAttempt)
    private readonly loginAttemptRepository: Repository<LoginAttempt>,
    @InjectRepository(ApiUsageLog)
    private readonly apiUsageRepository: Repository<ApiUsageLog>,
    @InjectRepository(UserSession)
    private readonly sessionRepository: Repository<UserSession>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Start periodic flush
    setInterval(() => this.flushBuffer(), this.FLUSH_INTERVAL);
  }

  // ============================================================================
  // Activity Logging
  // ============================================================================

  /**
   * Log an activity (buffered for performance)
   */
  async logActivity(params: LogActivityParams): Promise<void> {
    const log = this.activityRepository.create({
      category: params.category,
      action: params.action,
      description: params.description,
      severity: params.severity || this.determineSeverity(params),
      tenantId: params.tenantId || null,
      tenantName: params.tenantName || null,
      userId: params.userId || null,
      userName: params.userName || null,
      userEmail: params.userEmail || null,
      entityType: params.entityType || null,
      entityId: params.entityId || null,
      entityName: params.entityName || null,
      ipAddress: params.ipAddress,
      geoLocation: params.geoLocation || null,
      deviceInfo: params.deviceInfo || null,
      requestInfo: params.requestInfo || null,
      sessionId: params.sessionId || null,
      correlationId: params.correlationId || null,
      previousValue: params.previousValue || null,
      newValue: params.newValue || null,
      changedFields: params.changedFields || null,
      metadata: params.metadata || null,
      tags: params.tags || null,
      success: params.success ?? true,
      errorMessage: params.errorMessage || null,
      errorCode: params.errorCode || null,
      duration: params.duration || null,
    });

    this.logBuffer.push(log);

    // Flush if buffer is full
    if (this.logBuffer.length >= this.BUFFER_SIZE) {
      await this.flushBuffer();
    }
  }

  /**
   * Log activity immediately (bypass buffer)
   */
  async logActivityImmediate(params: LogActivityParams): Promise<ActivityLog> {
    const log = this.activityRepository.create({
      ...params,
      severity: params.severity || this.determineSeverity(params),
    });
    return this.activityRepository.save(log);
  }

  /**
   * Flush the log buffer to database
   */
  private async flushBuffer(): Promise<void> {
    if (this.logBuffer.length === 0) return;

    const logsToSave = [...this.logBuffer];
    this.logBuffer = [];

    try {
      await this.activityRepository.save(logsToSave);
    } catch (error) {
      this.logger.error(`Failed to flush activity logs: ${(error as Error).message}`);
      // Re-add to buffer on failure
      this.logBuffer.unshift(...logsToSave);
    }
  }

  /**
   * Determine severity based on action type
   */
  private determineSeverity(params: LogActivityParams): ActivitySeverity {
    // Critical events
    if (params.category === 'security_event') return 'warning';
    if (params.action.includes('delete') && params.entityType) return 'warning';
    if (!params.success) return 'error';

    // Info events
    if (params.action.includes('view') || params.action.includes('read')) return 'info';
    if (params.action.includes('login') || params.action.includes('logout')) return 'info';

    // Default
    return 'info';
  }

  // ============================================================================
  // Specialized Logging Methods
  // ============================================================================

  /**
   * Log user action (CRUD operations)
   */
  async logUserAction(params: {
    action: 'create' | 'update' | 'delete' | 'view' | 'export' | 'import';
    entityType: string;
    entityId: string;
    entityName?: string;
    previousValue?: Record<string, unknown>;
    newValue?: Record<string, unknown>;
    userId: string;
    userName: string;
    tenantId?: string;
    ipAddress: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const changedFields = params.previousValue && params.newValue
      ? this.getChangedFields(params.previousValue, params.newValue)
      : undefined;

    await this.logActivity({
      category: 'user_action',
      action: `${params.action}_${params.entityType}`,
      description: `User ${params.userName} ${params.action}d ${params.entityType}: ${params.entityName || params.entityId}`,
      entityType: params.entityType,
      entityId: params.entityId,
      entityName: params.entityName,
      previousValue: params.previousValue,
      newValue: params.newValue,
      changedFields,
      userId: params.userId,
      userName: params.userName,
      tenantId: params.tenantId,
      ipAddress: params.ipAddress,
      sessionId: params.sessionId,
      metadata: params.metadata,
      tags: [params.action, params.entityType],
    });
  }

  /**
   * Log system event
   */
  async logSystemEvent(params: {
    action: string;
    description: string;
    severity?: ActivitySeverity;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
    success?: boolean;
    errorMessage?: string;
  }): Promise<void> {
    await this.logActivity({
      category: 'system_event',
      action: params.action,
      description: params.description,
      severity: params.severity || 'info',
      entityType: params.entityType,
      entityId: params.entityId,
      metadata: params.metadata,
      success: params.success ?? true,
      errorMessage: params.errorMessage,
      ipAddress: '127.0.0.1', // System IP
      tags: ['system', params.action],
    });
  }

  /**
   * Log configuration change
   */
  async logConfigurationChange(params: {
    configKey: string;
    previousValue: unknown;
    newValue: unknown;
    userId: string;
    userName: string;
    ipAddress: string;
    tenantId?: string;
  }): Promise<void> {
    await this.logActivity({
      category: 'configuration',
      action: 'update_configuration',
      description: `Configuration "${params.configKey}" changed by ${params.userName}`,
      severity: 'warning',
      entityType: 'configuration',
      entityId: params.configKey,
      previousValue: { value: params.previousValue } as Record<string, unknown>,
      newValue: { value: params.newValue } as Record<string, unknown>,
      changedFields: [params.configKey],
      userId: params.userId,
      userName: params.userName,
      tenantId: params.tenantId,
      ipAddress: params.ipAddress,
      tags: ['configuration', 'change'],
    });
  }

  /**
   * Log data access
   */
  async logDataAccess(params: {
    entityType: string;
    entityId: string;
    accessType: 'read' | 'export' | 'download';
    userId: string;
    userName: string;
    tenantId?: string;
    ipAddress: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.logActivity({
      category: 'data_access',
      action: `${params.accessType}_${params.entityType}`,
      description: `${params.userName} accessed ${params.entityType}: ${params.entityId}`,
      entityType: params.entityType,
      entityId: params.entityId,
      userId: params.userId,
      userName: params.userName,
      tenantId: params.tenantId,
      ipAddress: params.ipAddress,
      metadata: params.metadata,
      tags: ['data_access', params.accessType, params.entityType],
    });
  }

  // ============================================================================
  // Login Tracking
  // ============================================================================

  /**
   * Record login attempt
   */
  async recordLoginAttempt(params: {
    email: string;
    ipAddress: string;
    success: boolean;
    failureReason?: string;
    geoLocation?: GeoLocation;
    deviceInfo?: DeviceInfo;
    tenantId?: string;
    userId?: string;
    sessionId?: string;
  }): Promise<LoginAttempt> {
    const attempt = this.loginAttemptRepository.create({
      email: params.email,
      ipAddress: params.ipAddress,
      success: params.success,
      failureReason: params.failureReason || null,
      geoLocation: params.geoLocation || null,
      deviceInfo: params.deviceInfo || null,
      tenantId: params.tenantId || null,
      userId: params.userId || null,
      sessionId: params.sessionId || null,
    });

    const saved = await this.loginAttemptRepository.save(attempt);

    // Also log as activity
    await this.logActivity({
      category: 'authentication',
      action: params.success ? 'login_success' : 'login_failed',
      description: params.success
        ? `Successful login for ${params.email}`
        : `Failed login attempt for ${params.email}: ${params.failureReason}`,
      severity: params.success ? 'info' : 'warning',
      userId: params.userId,
      userEmail: params.email,
      tenantId: params.tenantId,
      ipAddress: params.ipAddress,
      geoLocation: params.geoLocation,
      deviceInfo: params.deviceInfo,
      sessionId: params.sessionId,
      success: params.success,
      errorMessage: params.failureReason,
      tags: ['authentication', params.success ? 'success' : 'failed'],
    });

    return saved;
  }

  /**
   * Get recent login attempts for IP
   */
  async getRecentLoginAttempts(
    ipAddress: string,
    minutes: number = 15,
  ): Promise<LoginAttempt[]> {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return this.loginAttemptRepository.find({
      where: {
        ipAddress,
        createdAt: MoreThan(since),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get failed login count for IP
   */
  async getFailedLoginCount(ipAddress: string, minutes: number = 15): Promise<number> {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return this.loginAttemptRepository.count({
      where: {
        ipAddress,
        success: false,
        createdAt: MoreThan(since),
      },
    });
  }

  /**
   * Get failed login count for email
   */
  async getFailedLoginCountByEmail(email: string, minutes: number = 15): Promise<number> {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return this.loginAttemptRepository.count({
      where: {
        email,
        success: false,
        createdAt: MoreThan(since),
      },
    });
  }

  // ============================================================================
  // API Usage Logging
  // ============================================================================

  /**
   * Log API usage
   */
  async logApiUsage(params: {
    tenantId?: string;
    userId?: string;
    apiKeyId?: string;
    method: string;
    endpoint: string;
    path: string;
    queryParams?: Record<string, unknown>;
    requestSize?: number;
    statusCode: number;
    responseSize?: number;
    responseTimeMs: number;
    ipAddress: string;
    userAgent?: string;
    geoLocation?: GeoLocation;
    rateLimitRemaining?: number;
    rateLimitExceeded?: boolean;
    isError?: boolean;
    errorCode?: string;
    errorMessage?: string;
    correlationId?: string;
  }): Promise<void> {
    const log = this.apiUsageRepository.create({
      tenantId: params.tenantId || null,
      userId: params.userId || null,
      apiKeyId: params.apiKeyId || null,
      method: params.method,
      endpoint: params.endpoint,
      path: params.path,
      queryParams: params.queryParams || null,
      requestSize: params.requestSize || null,
      statusCode: params.statusCode,
      responseSize: params.responseSize || null,
      responseTimeMs: params.responseTimeMs,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent || null,
      geoLocation: params.geoLocation || null,
      rateLimitRemaining: params.rateLimitRemaining || null,
      rateLimitExceeded: params.rateLimitExceeded || false,
      isError: params.isError || params.statusCode >= 400,
      errorCode: params.errorCode || null,
      errorMessage: params.errorMessage || null,
      correlationId: params.correlationId || null,
    });

    await this.apiUsageRepository.save(log);
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Create session record
   */
  async createSession(params: {
    sessionToken: string;
    userId: string;
    userName: string;
    tenantId?: string;
    tenantName?: string;
    expiresAt: Date;
    ipAddress: string;
    geoLocation?: GeoLocation;
    deviceInfo?: DeviceInfo;
  }): Promise<UserSession> {
    const session = this.sessionRepository.create({
      sessionToken: params.sessionToken,
      userId: params.userId,
      userName: params.userName,
      tenantId: params.tenantId || null,
      tenantName: params.tenantName || null,
      isActive: true,
      expiresAt: params.expiresAt,
      ipAddress: params.ipAddress,
      geoLocation: params.geoLocation || null,
      deviceInfo: params.deviceInfo || null,
      requestCount: 0,
      lastActivityAt: new Date(),
    });

    return this.sessionRepository.save(session);
  }

  /**
   * Update session activity
   */
  async updateSessionActivity(
    sessionToken: string,
    path: string,
  ): Promise<void> {
    await this.sessionRepository.update(
      { sessionToken, isActive: true },
      {
        requestCount: () => 'request_count + 1',
        lastActivityAt: new Date(),
        lastActivityPath: path,
      },
    );
  }

  /**
   * Terminate session
   */
  async terminateSession(
    sessionToken: string,
    reason: 'logout' | 'expired' | 'forced' | 'security',
    terminatedBy?: string,
  ): Promise<void> {
    await this.sessionRepository.update(
      { sessionToken },
      {
        isActive: false,
        terminatedAt: new Date(),
        terminationReason: reason,
        terminatedBy: terminatedBy || null,
      },
    );
  }

  /**
   * Get active sessions for user
   */
  async getActiveSessionsForUser(userId: string): Promise<UserSession[]> {
    return this.sessionRepository.find({
      where: { userId, isActive: true },
      order: { lastActivityAt: 'DESC' },
    });
  }

  /**
   * Terminate all sessions for user
   */
  async terminateAllUserSessions(
    userId: string,
    reason: 'logout' | 'forced' | 'security',
    terminatedBy?: string,
  ): Promise<number> {
    const result = await this.sessionRepository.update(
      { userId, isActive: true },
      {
        isActive: false,
        terminatedAt: new Date(),
        terminationReason: reason,
        terminatedBy: terminatedBy || null,
      },
    );
    return result.affected || 0;
  }

  // ============================================================================
  // Query Activities
  // ============================================================================

  /**
   * Query activities with filters
   */
  async queryActivities(options: ActivityQueryOptions): Promise<{
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
      category,
      severity,
      action,
      entityType,
      entityId,
      ipAddress,
      success,
      startDate,
      endDate,
      searchQuery,
      tags,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const qb = this.activityRepository.createQueryBuilder('activity');

    if (tenantId) qb.andWhere('activity.tenantId = :tenantId', { tenantId });
    if (userId) qb.andWhere('activity.userId = :userId', { userId });
    if (category) qb.andWhere('activity.category = :category', { category });
    if (severity) qb.andWhere('activity.severity = :severity', { severity });
    if (action) qb.andWhere('activity.action LIKE :action', { action: `%${action}%` });
    if (entityType) qb.andWhere('activity.entityType = :entityType', { entityType });
    if (entityId) qb.andWhere('activity.entityId = :entityId', { entityId });
    if (ipAddress) qb.andWhere('activity.ipAddress = :ipAddress', { ipAddress });
    if (success !== undefined) qb.andWhere('activity.success = :success', { success });
    if (startDate) qb.andWhere('activity.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('activity.createdAt <= :endDate', { endDate });

    if (searchQuery) {
      qb.andWhere(
        '(activity.description ILIKE :search OR activity.userName ILIKE :search OR activity.entityName ILIKE :search)',
        { search: `%${searchQuery}%` },
      );
    }

    if (tags && tags.length > 0) {
      qb.andWhere('activity.tags && ARRAY[:...tags]', { tags });
    }

    qb.orderBy(`activity.${sortBy}`, sortOrder);
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Get activity by ID
   */
  async getActivityById(id: string): Promise<ActivityLog | null> {
    return this.activityRepository.findOne({ where: { id } });
  }

  /**
   * Get activities for entity
   */
  async getActivitiesForEntity(
    entityType: string,
    entityId: string,
    limit: number = 50,
  ): Promise<ActivityLog[]> {
    return this.activityRepository.find({
      where: { entityType, entityId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get activity statistics
   */
  async getActivityStats(options: {
    tenantId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<ActivityStats> {
    const { tenantId, startDate, endDate } = options;

    const qb = this.activityRepository.createQueryBuilder('activity');

    if (tenantId) qb.andWhere('activity.tenantId = :tenantId', { tenantId });
    if (startDate) qb.andWhere('activity.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('activity.createdAt <= :endDate', { endDate });

    // Total count
    const totalActivities = await qb.getCount();

    // By category
    const categoryStats = await this.activityRepository
      .createQueryBuilder('activity')
      .select('activity.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('activity.category')
      .getRawMany();

    const byCategory = {} as Record<ActivityCategory, number>;
    categoryStats.forEach((s) => {
      byCategory[s.category as ActivityCategory] = parseInt(s.count, 10);
    });

    // By severity
    const severityStats = await this.activityRepository
      .createQueryBuilder('activity')
      .select('activity.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('activity.severity')
      .getRawMany();

    const bySeverity = {} as Record<ActivitySeverity, number>;
    severityStats.forEach((s) => {
      bySeverity[s.severity as ActivitySeverity] = parseInt(s.count, 10);
    });

    // By success
    const successStats = await this.activityRepository
      .createQueryBuilder('activity')
      .select('activity.success', 'success')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('activity.success')
      .getRawMany();

    const bySuccess = { success: 0, failure: 0 };
    successStats.forEach((s) => {
      if (s.success === true || s.success === 'true') {
        bySuccess.success = parseInt(s.count, 10);
      } else {
        bySuccess.failure = parseInt(s.count, 10);
      }
    });

    // Top actions
    const topActions = await this.activityRepository
      .createQueryBuilder('activity')
      .select('activity.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('activity.action')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Top users
    const topUsers = await this.activityRepository
      .createQueryBuilder('activity')
      .select('activity.userId', 'userId')
      .addSelect('activity.userName', 'userName')
      .addSelect('COUNT(*)', 'count')
      .where('activity.userId IS NOT NULL')
      .andWhere(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('activity.userId')
      .addGroupBy('activity.userName')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Top IPs
    const topIPs = await this.activityRepository
      .createQueryBuilder('activity')
      .select('activity.ipAddress', 'ip')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('activity.ipAddress')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Activity over time (last 30 days by default)
    const activityOverTime = await this.activityRepository
      .createQueryBuilder('activity')
      .select("DATE(activity.createdAt)", 'date')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'activity.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere(startDate ? 'activity.createdAt >= :startDate' : '1=1', { startDate })
      .andWhere(endDate ? 'activity.createdAt <= :endDate' : '1=1', { endDate })
      .groupBy('DATE(activity.createdAt)')
      .orderBy('date', 'ASC')
      .getRawMany();

    return {
      totalActivities,
      byCategory,
      bySeverity,
      bySuccess,
      topActions: topActions.map((a) => ({
        action: a.action,
        count: parseInt(a.count, 10),
      })),
      topUsers: topUsers.map((u) => ({
        userId: u.userId,
        userName: u.userName || 'Unknown',
        count: parseInt(u.count, 10),
      })),
      topIPs: topIPs.map((i) => ({
        ip: i.ip,
        count: parseInt(i.count, 10),
      })),
      activityOverTime: activityOverTime.map((a) => ({
        date: a.date,
        count: parseInt(a.count, 10),
      })),
    };
  }

  // ============================================================================
  // Cleanup & Maintenance
  // ============================================================================

  /**
   * Archive old activity logs
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async archiveOldLogs(): Promise<void> {
    const archiveDate = new Date();
    archiveDate.setDate(archiveDate.getDate() - 90); // Archive logs older than 90 days

    const result = await this.activityRepository.update(
      {
        createdAt: LessThan(archiveDate),
        isArchived: false,
      },
      {
        isArchived: true,
        archivedAt: new Date(),
      },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Archived ${result.affected} activity logs`);
    }
  }

  /**
   * Clean up expired sessions
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSessions(): Promise<void> {
    const result = await this.sessionRepository.update(
      {
        isActive: true,
        expiresAt: LessThan(new Date()),
      },
      {
        isActive: false,
        terminatedAt: new Date(),
        terminationReason: 'expired',
      },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} expired sessions`);
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get changed fields between two objects
   */
  private getChangedFields(
    previous: Record<string, unknown>,
    current: Record<string, unknown>,
  ): string[] {
    const fields: string[] = [];
    const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);

    for (const key of allKeys) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) {
        fields.push(key);
      }
    }

    return fields;
  }
}
