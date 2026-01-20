import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';

import {
  ErrorOccurrence,
  ErrorGroup,
  ErrorAlertRule,
  ErrorSeverity,
  ErrorStatus,
  StackFrame,
  ErrorContext,
} from '../entities/error-tracking.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface ErrorReport {
  message: string;
  errorType?: string;
  stackTrace?: string;
  severity?: ErrorSeverity;
  context?: ErrorContext;
  service?: string;
  environment?: string;
  release?: string;
  tenantId?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorDashboard {
  totalErrors: number;
  newErrors: number;
  unresolvedGroups: number;
  errorsByService: Array<{ service: string; count: number }>;
  errorsBySeverity: Array<{ severity: ErrorSeverity; count: number }>;
  recentErrors: ErrorOccurrence[];
  topErrorGroups: ErrorGroup[];
  errorTrend: Array<{ date: string; count: number }>;
}

export interface AlertNotification {
  ruleId: string;
  ruleName: string;
  errorGroup: ErrorGroup;
  triggeredAt: Date;
  message: string;
}

// ============================================================================
// Error Tracking Service
// ============================================================================

@Injectable()
export class ErrorTrackingService {
  private readonly logger = new Logger(ErrorTrackingService.name);
  private alertCooldowns: Map<string, Date> = new Map();
  private notificationHandlers: Map<string, (notification: AlertNotification) => Promise<void>> = new Map();

  constructor(
    @InjectRepository(ErrorOccurrence)
    private readonly occurrenceRepo: Repository<ErrorOccurrence>,
    @InjectRepository(ErrorGroup)
    private readonly groupRepo: Repository<ErrorGroup>,
    @InjectRepository(ErrorAlertRule)
    private readonly alertRuleRepo: Repository<ErrorAlertRule>,
  ) {
    // Register default notification handlers
    this.registerNotificationHandler('email', this.sendEmailNotification.bind(this));
    this.registerNotificationHandler('slack', this.sendSlackNotification.bind(this));
    this.registerNotificationHandler('webhook', this.sendWebhookNotification.bind(this));
  }

  // ============================================================================
  // Error Reporting
  // ============================================================================

  async reportError(report: ErrorReport): Promise<ErrorOccurrence> {
    const fingerprint = this.generateFingerprint(report);
    const stackFrames = this.parseStackTrace(report.stackTrace);
    const culprit = this.extractCulprit(stackFrames);

    // Find or create error group
    let group = await this.groupRepo.findOne({ where: { fingerprint } });
    const isNewGroup = !group;

    if (group) {
      // Update existing group
      group.occurrenceCount++;
      group.lastSeenAt = new Date();

      // Track unique users
      if (report.userId && !group.affectedTenants?.includes(report.tenantId || '')) {
        group.userCount = (group.userCount || 0) + 1;
      }

      // Track affected tenants
      if (report.tenantId) {
        const tenants = group.affectedTenants || [];
        if (!tenants.includes(report.tenantId)) {
          tenants.push(report.tenantId);
          group.affectedTenants = tenants;
        }
      }

      // Track releases
      if (report.release) {
        const releases = group.affectedReleases || [];
        if (!releases.includes(report.release)) {
          releases.push(report.release);
          group.affectedReleases = releases;
        }
      }

      // Check for regression
      if (group.status === ErrorStatus.RESOLVED) {
        group.status = ErrorStatus.RECURRING;
        group.isRegression = true;
      }
    } else {
      // Create new group
      group = this.groupRepo.create({
        fingerprint,
        severity: report.severity || ErrorSeverity.ERROR,
        status: ErrorStatus.NEW,
        message: report.message.substring(0, 500),
        errorType: report.errorType,
        service: report.service,
        culprit,
        occurrenceCount: 1,
        userCount: report.userId ? 1 : 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        affectedTenants: report.tenantId ? [report.tenantId] : [],
        affectedReleases: report.release ? [report.release] : [],
      });
    }

    await this.groupRepo.save(group);

    // Create occurrence
    const occurrence = this.occurrenceRepo.create({
      groupId: group.id,
      fingerprint,
      severity: report.severity || ErrorSeverity.ERROR,
      message: report.message,
      errorType: report.errorType,
      stackTrace: report.stackTrace,
      stackFrames,
      context: report.context,
      service: report.service,
      environment: report.environment,
      release: report.release,
      tenantId: report.tenantId,
      userId: report.userId,
      ipAddress: report.ipAddress,
      userAgent: report.userAgent,
      metadata: report.metadata,
      timestamp: new Date(),
    });

    const savedOccurrence = await this.occurrenceRepo.save(occurrence);

    // Check alert rules
    await this.checkAlertRules(group, isNewGroup);

    return savedOccurrence;
  }

  private generateFingerprint(report: ErrorReport): string {
    // Create a stable fingerprint based on error characteristics
    const components = [
      report.errorType || 'unknown',
      report.service || 'unknown',
      this.normalizeMessage(report.message),
      this.extractCulpritFromStack(report.stackTrace),
    ].filter(Boolean);

    return crypto.createHash('sha256').update(components.join('|')).digest('hex').substring(0, 64);
  }

  private normalizeMessage(message: string): string {
    // Remove variable parts like IDs, timestamps, etc.
    return message
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{uuid}')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\b/g, '{timestamp}')
      .replace(/\b\d+\b/g, '{number}')
      .replace(/["'][^"']+["']/g, '{string}')
      .substring(0, 200);
  }

  private parseStackTrace(stackTrace?: string): StackFrame[] {
    if (!stackTrace) return [];

    const frames: StackFrame[] = [];
    const lines = stackTrace.split('\n');

    for (const line of lines) {
      // Parse Node.js style stack traces
      const match = line.match(/at\s+(?:(.+?)\s+)?\(?(.+?):(\d+):(\d+)\)?/);
      if (match && match[2] && match[3] && match[4]) {
        frames.push({
          function: match[1] || '<anonymous>',
          filename: match[2],
          lineno: parseInt(match[3], 10),
          colno: parseInt(match[4], 10),
          inApp: !match[2].includes('node_modules'),
        });
      }
    }

    return frames;
  }

  private extractCulprit(frames: StackFrame[]): string {
    // Find the first in-app frame
    const inAppFrame = frames.find((f) => f.inApp);
    if (inAppFrame) {
      return `${inAppFrame.function} at ${inAppFrame.filename}:${inAppFrame.lineno}`;
    }
    const first = frames[0];
    if (first) {
      return `${first.function} at ${first.filename}:${first.lineno}`;
    }
    return 'Unknown';
  }

  private extractCulpritFromStack(stackTrace?: string): string {
    if (!stackTrace) return '';
    const frames = this.parseStackTrace(stackTrace);
    const inAppFrame = frames.find((f) => f.inApp);
    return inAppFrame ? `${inAppFrame.filename}:${inAppFrame.function}` : '';
  }

  // ============================================================================
  // Error Group Management
  // ============================================================================

  async getErrorGroup(id: string): Promise<ErrorGroup> {
    const group = await this.groupRepo.findOne({ where: { id } });
    if (!group) {
      throw new NotFoundException(`Error group not found: ${id}`);
    }
    return group;
  }

  async updateErrorGroupStatus(
    id: string,
    status: ErrorStatus,
    userId?: string,
    notes?: string,
  ): Promise<ErrorGroup> {
    const group = await this.getErrorGroup(id);

    group.status = status;

    if (status === ErrorStatus.RESOLVED) {
      group.resolvedAt = new Date();
      group.resolvedBy = userId ?? null!;
      group.resolutionNotes = notes ?? null!;
      group.isRegression = false;
    }

    return this.groupRepo.save(group);
  }

  async assignErrorGroup(id: string, assigneeId: string): Promise<ErrorGroup> {
    const group = await this.getErrorGroup(id);
    group.assignedTo = assigneeId;
    group.status = ErrorStatus.IN_PROGRESS;
    return this.groupRepo.save(group);
  }

  async addNoteToErrorGroup(id: string, note: string): Promise<ErrorGroup> {
    const group = await this.getErrorGroup(id);
    group.notes = group.notes ? `${group.notes}\n\n${note}` : note;
    return this.groupRepo.save(group);
  }

  async linkTicket(id: string, ticketUrl: string): Promise<ErrorGroup> {
    const group = await this.getErrorGroup(id);
    group.linkedTicketUrl = ticketUrl;
    return this.groupRepo.save(group);
  }

  async mergeErrorGroups(targetId: string, sourceIds: string[]): Promise<ErrorGroup> {
    const target = await this.getErrorGroup(targetId);
    const sources = await this.groupRepo.find({ where: { id: In(sourceIds) } });

    // Update occurrences to point to target group
    await this.occurrenceRepo
      .createQueryBuilder()
      .update()
      .set({ groupId: targetId })
      .where('groupId IN (:...ids)', { ids: sourceIds })
      .execute();

    // Aggregate counts
    for (const source of sources) {
      target.occurrenceCount += source.occurrenceCount;
      target.userCount += source.userCount;

      if (source.firstSeenAt < target.firstSeenAt) {
        target.firstSeenAt = source.firstSeenAt;
      }
      if (source.lastSeenAt > target.lastSeenAt) {
        target.lastSeenAt = source.lastSeenAt;
      }

      // Merge affected tenants and releases
      const tenants = new Set([...(target.affectedTenants || []), ...(source.affectedTenants || [])]);
      const releases = new Set([...(target.affectedReleases || []), ...(source.affectedReleases || [])]);
      target.affectedTenants = Array.from(tenants);
      target.affectedReleases = Array.from(releases);
    }

    await this.groupRepo.save(target);

    // Delete source groups
    await this.groupRepo.delete({ id: In(sourceIds) });

    return target;
  }

  async queryErrorGroups(params: {
    status?: ErrorStatus;
    severity?: ErrorSeverity;
    service?: string;
    search?: string;
    assignedTo?: string;
    isRegression?: boolean;
    page?: number;
    limit?: number;
    sortBy?: 'occurrenceCount' | 'lastSeenAt' | 'firstSeenAt' | 'userCount';
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<{ items: ErrorGroup[]; total: number }> {
    const query = this.groupRepo.createQueryBuilder('g');

    if (params.status) {
      query.andWhere('g.status = :status', { status: params.status });
    }
    if (params.severity) {
      query.andWhere('g.severity = :severity', { severity: params.severity });
    }
    if (params.service) {
      query.andWhere('g.service = :service', { service: params.service });
    }
    if (params.assignedTo) {
      query.andWhere('g.assignedTo = :assignedTo', { assignedTo: params.assignedTo });
    }
    if (params.isRegression !== undefined) {
      query.andWhere('g.isRegression = :isRegression', { isRegression: params.isRegression });
    }
    if (params.search) {
      query.andWhere(
        '(g.message ILIKE :search OR g.errorType ILIKE :search OR g.culprit ILIKE :search)',
        { search: `%${params.search}%` },
      );
    }

    const sortBy = params.sortBy || 'lastSeenAt';
    const sortOrder = params.sortOrder || 'DESC';
    query.orderBy(`g.${sortBy}`, sortOrder);

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Error Occurrences
  // ============================================================================

  async getErrorOccurrence(id: string): Promise<ErrorOccurrence> {
    const occurrence = await this.occurrenceRepo.findOne({ where: { id } });
    if (!occurrence) {
      throw new NotFoundException(`Error occurrence not found: ${id}`);
    }
    return occurrence;
  }

  async getOccurrencesForGroup(
    groupId: string,
    params: { page?: number; limit?: number },
  ): Promise<{ items: ErrorOccurrence[]; total: number }> {
    const page = params.page || 1;
    const limit = params.limit || 20;

    const [items, total] = await this.occurrenceRepo.findAndCount({
      where: { groupId },
      order: { timestamp: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, total };
  }

  async queryOccurrences(params: {
    service?: string;
    severity?: ErrorSeverity;
    tenantId?: string;
    userId?: string;
    environment?: string;
    start?: Date;
    end?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ items: ErrorOccurrence[]; total: number }> {
    const query = this.occurrenceRepo.createQueryBuilder('o');

    if (params.service) {
      query.andWhere('o.service = :service', { service: params.service });
    }
    if (params.severity) {
      query.andWhere('o.severity = :severity', { severity: params.severity });
    }
    if (params.tenantId) {
      query.andWhere('o.tenantId = :tenantId', { tenantId: params.tenantId });
    }
    if (params.userId) {
      query.andWhere('o.userId = :userId', { userId: params.userId });
    }
    if (params.environment) {
      query.andWhere('o.environment = :environment', { environment: params.environment });
    }
    if (params.start) {
      query.andWhere('o.timestamp >= :start', { start: params.start });
    }
    if (params.end) {
      query.andWhere('o.timestamp <= :end', { end: params.end });
    }

    query.orderBy('o.timestamp', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 50;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  // ============================================================================
  // Alert Rules
  // ============================================================================

  async createAlertRule(data: {
    name: string;
    description?: string;
    conditions: {
      severity?: ErrorSeverity[];
      service?: string[];
      errorType?: string[];
      messagePattern?: string;
      occurrenceThreshold?: number;
      timeWindowMinutes?: number;
      userCountThreshold?: number;
    };
    actions: Array<{
      type: 'email' | 'slack' | 'pagerduty' | 'webhook' | 'sms';
      config: Record<string, unknown>;
    }>;
    cooldownMinutes?: number;
    createdBy?: string;
  }): Promise<ErrorAlertRule> {
    const rule = this.alertRuleRepo.create({
      ...data,
      isActive: true,
      cooldownMinutes: data.cooldownMinutes || 15,
      triggerCount: 0,
    });

    return this.alertRuleRepo.save(rule);
  }

  async updateAlertRule(
    id: string,
    data: Partial<ErrorAlertRule>,
  ): Promise<ErrorAlertRule> {
    const rule = await this.alertRuleRepo.findOne({ where: { id } });
    if (!rule) {
      throw new NotFoundException(`Alert rule not found: ${id}`);
    }

    Object.assign(rule, data);
    return this.alertRuleRepo.save(rule);
  }

  async deleteAlertRule(id: string): Promise<void> {
    await this.alertRuleRepo.delete(id);
  }

  async getAlertRules(): Promise<ErrorAlertRule[]> {
    return this.alertRuleRepo.find({ order: { name: 'ASC' } });
  }

  private async checkAlertRules(group: ErrorGroup, isNew: boolean): Promise<void> {
    const rules = await this.alertRuleRepo.find({ where: { isActive: true } });

    for (const rule of rules) {
      if (await this.shouldTriggerAlert(rule, group, isNew)) {
        await this.triggerAlert(rule, group);
      }
    }
  }

  private async shouldTriggerAlert(
    rule: ErrorAlertRule,
    group: ErrorGroup,
    isNew: boolean,
  ): Promise<boolean> {
    const conditions = rule.conditions;

    // Check cooldown
    const cooldownKey = `${rule.id}:${group.id}`;
    const lastTriggered = this.alertCooldowns.get(cooldownKey);
    if (lastTriggered) {
      const cooldownEnd = new Date(lastTriggered.getTime() + rule.cooldownMinutes * 60000);
      if (new Date() < cooldownEnd) {
        return false;
      }
    }

    // Check severity
    if (conditions.severity && conditions.severity.length > 0) {
      if (!conditions.severity.includes(group.severity)) {
        return false;
      }
    }

    // Check service
    if (conditions.service && conditions.service.length > 0) {
      if (!group.service || !conditions.service.includes(group.service)) {
        return false;
      }
    }

    // Check error type
    if (conditions.errorType && conditions.errorType.length > 0) {
      if (!group.errorType || !conditions.errorType.includes(group.errorType)) {
        return false;
      }
    }

    // Check message pattern
    if (conditions.messagePattern) {
      const regex = new RegExp(conditions.messagePattern, 'i');
      if (!regex.test(group.message)) {
        return false;
      }
    }

    // Check occurrence threshold
    if (conditions.occurrenceThreshold) {
      if (conditions.timeWindowMinutes) {
        // Count occurrences in time window
        const windowStart = new Date(Date.now() - conditions.timeWindowMinutes * 60000);
        const count = await this.occurrenceRepo.count({
          where: {
            groupId: group.id,
            timestamp: LessThan(windowStart),
          },
        });
        if (count < conditions.occurrenceThreshold) {
          return false;
        }
      } else if (group.occurrenceCount < conditions.occurrenceThreshold) {
        return false;
      }
    }

    // Check user count threshold
    if (conditions.userCountThreshold && group.userCount < conditions.userCountThreshold) {
      return false;
    }

    return true;
  }

  private async triggerAlert(rule: ErrorAlertRule, group: ErrorGroup): Promise<void> {
    const cooldownKey = `${rule.id}:${group.id}`;
    this.alertCooldowns.set(cooldownKey, new Date());

    rule.lastTriggeredAt = new Date();
    rule.triggerCount++;
    await this.alertRuleRepo.save(rule);

    const notification: AlertNotification = {
      ruleId: rule.id,
      ruleName: rule.name,
      errorGroup: group,
      triggeredAt: new Date(),
      message: `Alert: ${group.message} (${group.occurrenceCount} occurrences)`,
    };

    for (const action of rule.actions) {
      const handler = this.notificationHandlers.get(action.type);
      if (handler) {
        try {
          await handler(notification);
          this.logger.log(`Alert sent via ${action.type} for rule: ${rule.name}`);
        } catch (error) {
          this.logger.error(`Failed to send alert via ${action.type}`, error);
        }
      }
    }
  }

  // ============================================================================
  // Notification Handlers
  // ============================================================================

  registerNotificationHandler(
    type: string,
    handler: (notification: AlertNotification) => Promise<void>,
  ): void {
    this.notificationHandlers.set(type, handler);
  }

  private async sendEmailNotification(notification: AlertNotification): Promise<void> {
    // In production, this would integrate with an email service
    this.logger.log(`[Email] Alert: ${notification.message}`);
  }

  private async sendSlackNotification(notification: AlertNotification): Promise<void> {
    // In production, this would integrate with Slack API
    this.logger.log(`[Slack] Alert: ${notification.message}`);
  }

  private async sendWebhookNotification(notification: AlertNotification): Promise<void> {
    // In production, this would make HTTP request to webhook URL
    this.logger.log(`[Webhook] Alert: ${notification.message}`);
  }

  // ============================================================================
  // Dashboard & Analytics
  // ============================================================================

  async getErrorDashboard(params: {
    service?: string;
    start?: Date;
    end?: Date;
  }): Promise<ErrorDashboard> {
    const end = params.end || new Date();
    const start = params.start || new Date(end.getTime() - 24 * 60 * 60 * 1000);

    const baseQuery = this.occurrenceRepo
      .createQueryBuilder('o')
      .where('o.timestamp BETWEEN :start AND :end', { start, end });

    if (params.service) {
      baseQuery.andWhere('o.service = :service', { service: params.service });
    }

    // Total errors
    const totalErrors = await baseQuery.getCount();

    // New error groups
    const newErrors = await this.groupRepo.count({
      where: {
        status: ErrorStatus.NEW,
        firstSeenAt: LessThan(end),
      },
    });

    // Unresolved groups
    const unresolvedGroups = await this.groupRepo.count({
      where: {
        status: In([ErrorStatus.NEW, ErrorStatus.ACKNOWLEDGED, ErrorStatus.IN_PROGRESS]),
      },
    });

    // Errors by service
    const errorsByService = await this.occurrenceRepo
      .createQueryBuilder('o')
      .select('o.service', 'service')
      .addSelect('COUNT(*)', 'count')
      .where('o.timestamp BETWEEN :start AND :end', { start, end })
      .groupBy('o.service')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Errors by severity
    const errorsBySeverity = await this.occurrenceRepo
      .createQueryBuilder('o')
      .select('o.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('o.timestamp BETWEEN :start AND :end', { start, end })
      .groupBy('o.severity')
      .getRawMany();

    // Recent errors
    const recentErrors = await this.occurrenceRepo.find({
      where: params.service ? { service: params.service } : {},
      order: { timestamp: 'DESC' },
      take: 10,
    });

    // Top error groups
    const topErrorGroups = await this.groupRepo.find({
      where: {
        status: In([ErrorStatus.NEW, ErrorStatus.ACKNOWLEDGED, ErrorStatus.IN_PROGRESS, ErrorStatus.RECURRING]),
      },
      order: { occurrenceCount: 'DESC' },
      take: 10,
    });

    // Error trend
    const trendData = await this.occurrenceRepo
      .createQueryBuilder('o')
      .select("DATE_TRUNC('hour', o.timestamp)", 'date')
      .addSelect('COUNT(*)', 'count')
      .where('o.timestamp BETWEEN :start AND :end', { start, end })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany();

    const errorTrend = trendData.map((d) => ({
      date: d.date,
      count: parseInt(d.count, 10),
    }));

    return {
      totalErrors,
      newErrors,
      unresolvedGroups,
      errorsByService: errorsByService.map((e) => ({
        service: e.service || 'Unknown',
        count: parseInt(e.count, 10),
      })),
      errorsBySeverity: errorsBySeverity.map((e) => ({
        severity: e.severity,
        count: parseInt(e.count, 10),
      })),
      recentErrors,
      topErrorGroups,
      errorTrend,
    };
  }

  async getErrorStats(params: {
    groupBy: 'service' | 'errorType' | 'severity' | 'tenant';
    start?: Date;
    end?: Date;
  }): Promise<Array<{ key: string; count: number; percentage: number }>> {
    const end = params.end || new Date();
    const start = params.start || new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    const fieldMap: Record<string, string> = {
      service: 'o.service',
      errorType: 'o.errorType',
      severity: 'o.severity',
      tenant: 'o.tenantId',
    };

    const field = fieldMap[params.groupBy] || 'o.service';

    const result = await this.occurrenceRepo
      .createQueryBuilder('o')
      .select(field, 'key')
      .addSelect('COUNT(*)', 'count')
      .where('o.timestamp BETWEEN :start AND :end', { start, end })
      .groupBy(field)
      .orderBy('count', 'DESC')
      .getRawMany();

    const total = result.reduce((sum, r) => sum + parseInt(r.count, 10), 0);

    return result.map((r) => ({
      key: r.key || 'Unknown',
      count: parseInt(r.count, 10),
      percentage: total > 0 ? (parseInt(r.count, 10) / total) * 100 : 0,
    }));
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupOldErrors(): Promise<void> {
    const retentionDays = 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    // Delete old occurrences
    const deleteResult = await this.occurrenceRepo.delete({
      timestamp: LessThan(cutoff),
    });

    // Update group counts and delete empty groups
    const emptyGroups = await this.groupRepo
      .createQueryBuilder('g')
      .leftJoin('error_occurrences', 'o', 'o.groupId = g.id')
      .where('o.id IS NULL')
      .getMany();

    if (emptyGroups.length > 0) {
      await this.groupRepo.delete({ id: In(emptyGroups.map((g) => g.id)) });
    }

    this.logger.log(
      `Cleaned up ${deleteResult.affected} error occurrences and ${emptyGroups.length} empty groups`,
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async clearExpiredCooldowns(): Promise<void> {
    const now = Date.now();
    for (const [key, timestamp] of this.alertCooldowns.entries()) {
      if (now - timestamp.getTime() > 24 * 60 * 60 * 1000) { // 24 hours
        this.alertCooldowns.delete(key);
      }
    }
  }
}
