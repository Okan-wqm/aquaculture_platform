import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import * as crypto from 'crypto';

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThanOrEqual, In } from 'typeorm';
import { safeSortField, safeSortOrder } from '@aquaculture/backend-common/pagination';
import { safeRegex } from '@aquaculture/backend-common/security';
import { maskPii } from '@aquaculture/backend-common/utils';

import {
  ErrorOccurrence,
  ErrorGroup,
  ErrorAlertRule,
  ErrorSeverity,
  ErrorStatus,
  StackFrame,
  ErrorContext,
} from '../entities/error-tracking.entity';
import {
  ERROR_GROUP_SORT_COLUMNS,
  ERROR_GROUP_SORT_FIELDS,
  ErrorGroupSortField,
} from '../sorting/error-group-sort';
import { clampLimit } from '../../shared/sort-field.util';
import {
  createStandardPaginatedResult,
  type PaginationResultV1,
} from '@platform/pagination-contracts';

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

/**
 * Cap a masked string at the column width, marking that it was cut.
 *
 * `maskAndTruncatePii` is the shared helper, but it is typed for nullable input
 * and so returns `string | null`; both call sites here hold a required string
 * and write a NOT NULL `varchar(500)`. The marker matches the shared helper's
 * so forensic search finds every truncated value with one pattern.
 */
function truncateTo(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  const marker = '…<truncated>';
  return `${value.slice(0, maxLen - marker.length)}${marker}`;
}

// ============================================================================
// Error Tracking Service
// ============================================================================

@Injectable()
export class ErrorTrackingService {
  private readonly logger = new Logger(ErrorTrackingService.name);
  private alertCooldowns: Map<string, Date> = new Map();
  private activeRuleCache: { rules: ErrorAlertRule[]; loadedAt: number } | null = null;
  private static readonly RULE_CACHE_TTL_MS = 30_000;
  private notificationHandlers: Map<string, (notification: AlertNotification) => Promise<void>> =
    new Map();

  constructor(
    @InjectRepository(ErrorOccurrence)
    private readonly occurrenceRepo: Repository<ErrorOccurrence>,
    @InjectRepository(ErrorGroup)
    private readonly groupRepo: Repository<ErrorGroup>,
    @InjectRepository(ErrorAlertRule)
    private readonly alertRuleRepo: Repository<ErrorAlertRule>,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {
    // Register default notification handlers
    this.registerNotificationHandler('email', this.sendEmailNotification.bind(this));
    this.registerNotificationHandler('slack', this.sendSlackNotification.bind(this));
    this.registerNotificationHandler('webhook', this.sendWebhookNotification.bind(this));
  }

  // ============================================================================
  // Error Reporting
  // ============================================================================

  /**
   * Record one error occurrence and fold it into its group.
   *
   * # Why the group write is a single statement
   *
   * This was `findOne` -> mutate -> `save`, against a UNIQUE index on
   * `fingerprint`. Two identical errors arriving together — which is the
   * definition of an incident — both miss the read and both insert, and the
   * second gets a 23505. The race had never fired only because the method had
   * no callers at all; wiring an ingress in front of it would have converted it
   * from theoretical to guaranteed, firing hardest during the outage the error
   * tracker exists to record. `ON CONFLICT DO UPDATE` hands the decision to
   * PostgreSQL, which is the only participant that can make it.
   *
   * `xmax = 0` distinguishes the insert from the update, so the alert rules
   * still know whether this was a new group without a second read.
   *
   * # Why both messages are masked
   *
   * `admin.error_groups` is marked `excluded` in the tenant-erasure registry —
   * a platform-wide reference table, deliberately not erased with a tenant. An
   * unmasked message parks whatever a DB driver or a user-supplied string put
   * in it there permanently. The group's message is additionally normalized:
   * a group IS a signature, so it should read as one. And both are truncated,
   * because the columns are `varchar(500)` and nothing was truncating — a 5xx
   * with a long message would have failed the INSERT with a 22001.
   */
  async reportError(report: ErrorReport): Promise<ErrorOccurrence> {
    const fingerprint = this.generateFingerprint(report);
    const stackFrames = this.parseStackTrace(report.stackTrace);
    const culprit = this.extractCulprit(stackFrames);

    const { groupId, isNewGroup } = await this.upsertGroup(report, fingerprint, culprit);

    const occurrence = this.occurrenceRepo.create({
      groupId,
      fingerprint,
      severity: report.severity || ErrorSeverity.ERROR,
      message: truncateTo(maskPii(report.message), 500),
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

    const group = await this.groupRepo.findOneBy({ id: groupId });
    if (!group) {
      // The occurrence is stored; only the alert evaluation is lost. The group
      // was upserted microseconds ago, so its absence means a concurrent delete
      // or a merge — worth a line, and not worth failing a write that already
      // landed (the caller would retry and store the occurrence twice).
      this.logger.warn(`Error group ${groupId} vanished before alert evaluation`);
      return savedOccurrence;
    }

    await this.checkAlertRules(group, isNewGroup);

    return savedOccurrence;
  }

  /**
   * Fold one report into its group in one statement, returning the group's id
   * and whether this call created it. See `reportError` for why.
   */
  private async upsertGroup(
    report: ErrorReport,
    fingerprint: string,
    culprit: string | undefined,
  ): Promise<{ groupId: string; isNewGroup: boolean }> {
    const rows = (await this.groupRepo.query(
      `INSERT INTO "admin"."error_groups" AS g (
         "fingerprint", "severity", "status", "message", "errorType", "service", "culprit",
         "occurrenceCount", "firstSeenAt", "lastSeenAt",
         "affectedTenants", "affectedReleases", "isRegression", "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         1, now(), now(),
         CASE WHEN $8::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array($8::text) END,
         CASE WHEN $9::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array($9::text) END,
         false, now(), now()
       )
       ON CONFLICT ("fingerprint") DO UPDATE SET
         "occurrenceCount" = g."occurrenceCount" + 1,
         "lastSeenAt" = now(),
         "updatedAt" = now(),
         "status" = CASE WHEN g."status" = $10 THEN $11 ELSE g."status" END,
         "isRegression" = g."isRegression" OR g."status" = $10,
         "affectedTenants" = CASE
           WHEN $8::text IS NULL THEN g."affectedTenants"
           WHEN COALESCE(g."affectedTenants", '[]'::jsonb) @> jsonb_build_array($8::text)
             THEN g."affectedTenants"
           ELSE COALESCE(g."affectedTenants", '[]'::jsonb) || jsonb_build_array($8::text)
         END,
         "affectedReleases" = CASE
           WHEN $9::text IS NULL THEN g."affectedReleases"
           WHEN COALESCE(g."affectedReleases", '[]'::jsonb) @> jsonb_build_array($9::text)
             THEN g."affectedReleases"
           ELSE COALESCE(g."affectedReleases", '[]'::jsonb) || jsonb_build_array($9::text)
         END
       RETURNING g."id", (xmax = 0) AS inserted`,
      [
        fingerprint,
        report.severity || ErrorSeverity.ERROR,
        ErrorStatus.NEW,
        truncateTo(this.normalizeMessage(maskPii(report.message)), 500),
        report.errorType ?? null,
        report.service ?? null,
        culprit ?? null,
        report.tenantId ?? null,
        report.release ?? null,
        ErrorStatus.RESOLVED,
        ErrorStatus.RECURRING,
      ],
    )) as Array<{ id: string; inserted: boolean }>;

    const [row] = rows;
    if (!row) {
      // ON CONFLICT DO UPDATE always returns the row it touched; no rows means
      // the statement did not run as written, which must not be swallowed into
      // an occurrence pointing at a group that does not exist.
      throw new Error(`error_groups upsert returned no row for fingerprint ${fingerprint}`);
    }

    return { groupId: row.id, isNewGroup: row.inserted };
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

      if (source.firstSeenAt < target.firstSeenAt) {
        target.firstSeenAt = source.firstSeenAt;
      }
      if (source.lastSeenAt > target.lastSeenAt) {
        target.lastSeenAt = source.lastSeenAt;
      }

      // Merge affected tenants and releases
      const tenants = new Set([
        ...(target.affectedTenants || []),
        ...(source.affectedTenants || []),
      ]);
      const releases = new Set([
        ...(target.affectedReleases || []),
        ...(source.affectedReleases || []),
      ]);
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
    sortBy?: ErrorGroupSortField;
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<PaginationResultV1<ErrorGroup>> {
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

    // SEC-HIGH №1 / №17 (2026-08-23 scan): the sort column comes from the
    // ERROR_GROUP_SORT_COLUMNS map keyed by the validated field, and the page
    // limit is clamped — `orderBy` interpolates verbatim and `.take(limit)`
    // otherwise accepts any number.
    const normalizedSortField = safeSortField(
      params.sortBy,
      ERROR_GROUP_SORT_FIELDS,
      'lastSeenAt',
    ) as ErrorGroupSortField;
    query.orderBy(ERROR_GROUP_SORT_COLUMNS[normalizedSortField], safeSortOrder(params.sortOrder));

    const page = params.page || 1;
    const limit = clampLimit(params.limit, 20, 100);
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return createStandardPaginatedResult<ErrorGroup>(items, total, page, limit);
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
  ): Promise<PaginationResultV1<ErrorOccurrence>> {
    const page = params.page || 1;
    const limit = params.limit || 20;

    const [items, total] = await this.occurrenceRepo.findAndCount({
      where: { groupId },
      order: { timestamp: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return createStandardPaginatedResult<ErrorOccurrence>(items, total, page, limit);
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
  }): Promise<PaginationResultV1<ErrorOccurrence>> {
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
    return createStandardPaginatedResult<ErrorOccurrence>(items, total, page, limit);
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

    this.invalidateAlertRuleCache();
    return this.alertRuleRepo.save(rule);
  }

  async updateAlertRule(id: string, data: Partial<ErrorAlertRule>): Promise<ErrorAlertRule> {
    const rule = await this.alertRuleRepo.findOne({ where: { id } });
    if (!rule) {
      throw new NotFoundException(`Alert rule not found: ${id}`);
    }

    Object.assign(rule, data);
    this.invalidateAlertRuleCache();
    return this.alertRuleRepo.save(rule);
  }

  async deleteAlertRule(id: string): Promise<void> {
    await this.alertRuleRepo.delete(id);
    this.invalidateAlertRuleCache();
  }

  async getAlertRules(): Promise<ErrorAlertRule[]> {
    return this.alertRuleRepo.find({ order: { name: 'ASC' } });
  }

  /**
   * The active rule set, cached for a short window.
   *
   * Every error used to load ALL active rules from the database. Error volume
   * therefore amplified database load directly: a database-caused incident
   * produces 5xx, which produce more reads of the same database, which is a
   * loop that tightens exactly when it must not. A short TTL bounds the reads
   * to O(1) per window instead of O(errors), and rule mutations invalidate it
   * so an operator's change is visible immediately on the replica that made it
   * and within the window everywhere else.
   */
  private async activeAlertRules(): Promise<ErrorAlertRule[]> {
    const cached = this.activeRuleCache;
    if (cached && Date.now() - cached.loadedAt < ErrorTrackingService.RULE_CACHE_TTL_MS) {
      return cached.rules;
    }
    const rules = await this.alertRuleRepo.find({ where: { isActive: true } });
    this.activeRuleCache = { rules, loadedAt: Date.now() };
    return rules;
  }

  private invalidateAlertRuleCache(): void {
    this.activeRuleCache = null;
  }

  private async checkAlertRules(group: ErrorGroup, isNew: boolean): Promise<void> {
    const rules = await this.activeAlertRules();

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
      // SEC-LOW №11 (2026-08-23 scan): user pattern through the shared
      // ReDoS gate — unsafe/invalid patterns fail closed (no match).
      const regex = safeRegex(conditions.messagePattern, 'i');
      if (!regex || !regex.test(group.message)) {
        return false;
      }
    }

    // Check occurrence threshold
    if (conditions.occurrenceThreshold) {
      if (conditions.timeWindowMinutes) {
        // Occurrences INSIDE the window. This read `LessThan(windowStart)`,
        // the exact inverse: every windowed rule counted the occurrences it
        // was meant to ignore, so it could not fire on a live burst and fired
        // on stale history instead.
        const windowStart = new Date(Date.now() - conditions.timeWindowMinutes * 60000);
        const count = await this.occurrenceRepo.count({
          where: {
            groupId: group.id,
            timestamp: MoreThanOrEqual(windowStart),
          },
        });
        if (count < conditions.occurrenceThreshold) {
          return false;
        }
      } else if (group.occurrenceCount < conditions.occurrenceThreshold) {
        return false;
      }
    }

    // Check user count threshold.
    //
    // Derived, not stored: `error_groups."userCount"` was incremented when the
    // report's TENANT was new to the group, so it was a tenant count under a
    // user's name (migration 1809700000000 removed it). This is the only place
    // the number is used, the query runs only for a rule that asks for it, and
    // it runs last — after every cheaper predicate has had its chance to
    // return false.
    if (conditions.userCountThreshold) {
      const raw = await this.occurrenceRepo
        .createQueryBuilder('o')
        .select('COUNT(DISTINCT o."userId")', 'count')
        .where('o."groupId" = :groupId', { groupId: group.id })
        .andWhere('o."userId" IS NOT NULL')
        .getRawOne<{ count: string }>();
      const distinctUsers = raw ? Number(raw.count) : 0;
      if (distinctUsers < conditions.userCountThreshold) {
        return false;
      }
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
        status: In([
          ErrorStatus.NEW,
          ErrorStatus.ACKNOWLEDGED,
          ErrorStatus.IN_PROGRESS,
          ErrorStatus.RECURRING,
        ]),
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
  // Alert cooldowns
  // ============================================================================

  @ScheduledJob({
    name: 'error-tracking.clear-expired-cooldowns',
    cron: CronExpression.EVERY_HOUR,
    scope: 'each-replica',
  })
  async clearExpiredCooldowns(): Promise<void> {
    const now = Date.now();
    for (const [key, timestamp] of this.alertCooldowns.entries()) {
      if (now - timestamp.getTime() > 24 * 60 * 60 * 1000) {
        // 24 hours
        this.alertCooldowns.delete(key);
      }
    }
  }
}
