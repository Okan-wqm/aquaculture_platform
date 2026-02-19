/**
 * Alert Audit Service
 *
 * Comprehensive audit logging for all alert-related operations.
 * Tracks rule changes, incident lifecycle, escalations, notifications, and user actions.
 */

import * as crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Audit event category
 */
export enum AuditCategory {
  RULE = 'RULE',
  INCIDENT = 'INCIDENT',
  ESCALATION = 'ESCALATION',
  NOTIFICATION = 'NOTIFICATION',
  ACKNOWLEDGMENT = 'ACKNOWLEDGMENT',
  CONFIGURATION = 'CONFIGURATION',
  USER_ACTION = 'USER_ACTION',
  SYSTEM = 'SYSTEM',
}

/**
 * Audit event type
 */
export enum AuditEventType {
  // Rule events
  RULE_CREATED = 'RULE_CREATED',
  RULE_UPDATED = 'RULE_UPDATED',
  RULE_DELETED = 'RULE_DELETED',
  RULE_ENABLED = 'RULE_ENABLED',
  RULE_DISABLED = 'RULE_DISABLED',
  RULE_TRIGGERED = 'RULE_TRIGGERED',
  RULE_EVALUATION_FAILED = 'RULE_EVALUATION_FAILED',

  // Incident events
  INCIDENT_CREATED = 'INCIDENT_CREATED',
  INCIDENT_UPDATED = 'INCIDENT_UPDATED',
  INCIDENT_ACKNOWLEDGED = 'INCIDENT_ACKNOWLEDGED',
  INCIDENT_ASSIGNED = 'INCIDENT_ASSIGNED',
  INCIDENT_RESOLVED = 'INCIDENT_RESOLVED',
  INCIDENT_CLOSED = 'INCIDENT_CLOSED',
  INCIDENT_REOPENED = 'INCIDENT_REOPENED',
  INCIDENT_SUPPRESSED = 'INCIDENT_SUPPRESSED',
  INCIDENT_COMMENT_ADDED = 'INCIDENT_COMMENT_ADDED',

  // Escalation events
  ESCALATION_STARTED = 'ESCALATION_STARTED',
  ESCALATION_LEVEL_CHANGED = 'ESCALATION_LEVEL_CHANGED',
  ESCALATION_STOPPED = 'ESCALATION_STOPPED',
  ESCALATION_TIMEOUT = 'ESCALATION_TIMEOUT',
  ESCALATION_POLICY_CHANGED = 'ESCALATION_POLICY_CHANGED',

  // Notification events
  NOTIFICATION_SENT = 'NOTIFICATION_SENT',
  NOTIFICATION_DELIVERED = 'NOTIFICATION_DELIVERED',
  NOTIFICATION_FAILED = 'NOTIFICATION_FAILED',
  NOTIFICATION_RETRIED = 'NOTIFICATION_RETRIED',

  // Acknowledgment events
  ACK_REQUESTED = 'ACK_REQUESTED',
  ACK_RECEIVED = 'ACK_RECEIVED',
  ACK_EXPIRED = 'ACK_EXPIRED',
  ACK_UNACKNOWLEDGED = 'ACK_UNACKNOWLEDGED',

  // Configuration events
  CONFIG_CHANGED = 'CONFIG_CHANGED',
  CHANNEL_CONFIGURED = 'CHANNEL_CONFIGURED',
  TEMPLATE_UPDATED = 'TEMPLATE_UPDATED',
  POLICY_CREATED = 'POLICY_CREATED',
  POLICY_UPDATED = 'POLICY_UPDATED',
  POLICY_DELETED = 'POLICY_DELETED',

  // User action events
  USER_LOGIN = 'USER_LOGIN',
  USER_ACTION = 'USER_ACTION',
  BULK_OPERATION = 'BULK_OPERATION',
  API_CALL = 'API_CALL',

  // System events
  SYSTEM_STARTED = 'SYSTEM_STARTED',
  SYSTEM_STOPPED = 'SYSTEM_STOPPED',
  HEALTH_CHECK = 'HEALTH_CHECK',
  ERROR = 'ERROR',
  WARNING = 'WARNING',
}

/**
 * Audit severity level
 */
export enum AuditSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

/**
 * Audit entry
 */
export interface AuditEntry {
  id: string;
  category: AuditCategory;
  eventType: AuditEventType;
  severity: AuditSeverity;
  timestamp: Date;
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  userId?: string;
  userName?: string;
  ipAddress?: string;
  userAgent?: string;
  action: string;
  description: string;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  changes?: AuditChange[];
  metadata?: Record<string, unknown>;
  correlationId?: string;
  parentAuditId?: string;
  tags?: string[];
  duration?: number;
  success: boolean;
  errorMessage?: string;
}

/**
 * Audit change tracking
 */
export interface AuditChange {
  field: string;
  previousValue: unknown;
  newValue: unknown;
}

/**
 * Audit query options
 */
export interface AuditQueryOptions {
  category?: AuditCategory;
  eventType?: AuditEventType;
  severity?: AuditSeverity;
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  userId?: string;
  startTime?: Date;
  endTime?: Date;
  correlationId?: string;
  tags?: string[];
  success?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'timestamp' | 'severity';
  orderDirection?: 'ASC' | 'DESC';
}

/**
 * Audit statistics
 */
export interface AuditStatistics {
  totalEntries: number;
  entriesByCategory: Record<string, number>;
  entriesBySeverity: Record<string, number>;
  entriesByEventType: Record<string, number>;
  successRate: number;
  averageEntriesPerDay: number;
  topUsers: Array<{ userId: string; count: number }>;
  topEntities: Array<{ entityId: string; count: number }>;
  recentErrors: AuditEntry[];
}

/**
 * Audit report configuration
 */
export interface AuditReportConfig {
  title: string;
  startTime: Date;
  endTime: Date;
  categories?: AuditCategory[];
  severities?: AuditSeverity[];
  groupBy?: 'category' | 'eventType' | 'user' | 'entity' | 'day';
  includeChanges?: boolean;
  maxEntries?: number;
}

/**
 * Audit report
 */
export interface AuditReport {
  title: string;
  generatedAt: Date;
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalEntries: number;
    successCount: number;
    failureCount: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  entries: AuditEntry[];
  groupedData?: Record<string, AuditEntry[]>;
}

@Injectable()
export class AlertAuditService implements OnModuleInit {
  private readonly logger = new Logger(AlertAuditService.name);

  // In-memory storage for now - in production, use database
  private readonly entries: AuditEntry[] = [];
  // TODO: Migrate to database-backed audit store. In-memory is a temporary solution.
  // Capped at 2000 to bound heap usage — 10k entries × ~5 KB = ~50 MB worst case.
  // Historical queries should use the database, not this in-memory window.
  private readonly maxEntriesInMemory = 2000;

  // PE-15: Use AsyncLocalStorage for request-scoped correlation IDs.
  // A shared array (the previous approach) corrupts correlation IDs under
  // concurrent async requests because push/pop operates on a shared stack.
  private readonly correlationStorage = new AsyncLocalStorage<string>();

  // Metrics
  private metrics = {
    totalLogged: 0,
    byCategory: new Map<string, number>(),
    bySeverity: new Map<string, number>(),
    byEventType: new Map<string, number>(),
    successCount: 0,
    failureCount: 0,
  };

  constructor(private readonly eventEmitter: EventEmitter2) {}

  onModuleInit(): void {
    this.setupEventListeners();
    this.log({
      category: AuditCategory.SYSTEM,
      eventType: AuditEventType.SYSTEM_STARTED,
      severity: AuditSeverity.INFO,
      action: 'startup',
      description: 'Alert audit service started',
      success: true,
    });
    this.logger.log('AlertAuditService initialized');
  }

  /**
   * Setup event listeners for automatic audit logging
   */
  private setupEventListeners(): void {
    // Rule events
    this.eventEmitter.on('rule.created', (data: Record<string, unknown>) =>
      this.logRuleEvent(AuditEventType.RULE_CREATED, data),
    );
    this.eventEmitter.on('rule.updated', (data: Record<string, unknown>) =>
      this.logRuleEvent(AuditEventType.RULE_UPDATED, data),
    );
    this.eventEmitter.on('rule.deleted', (data: Record<string, unknown>) =>
      this.logRuleEvent(AuditEventType.RULE_DELETED, data),
    );
    this.eventEmitter.on('rule.triggered', (data: Record<string, unknown>) =>
      this.logRuleEvent(AuditEventType.RULE_TRIGGERED, data),
    );

    // Incident events
    this.eventEmitter.on('incident.created', (data: Record<string, unknown>) =>
      this.logIncidentEvent(AuditEventType.INCIDENT_CREATED, data),
    );
    this.eventEmitter.on('incident.acknowledged', (data: Record<string, unknown>) =>
      this.logIncidentEvent(AuditEventType.INCIDENT_ACKNOWLEDGED, data),
    );
    this.eventEmitter.on('incident.resolved', (data: Record<string, unknown>) =>
      this.logIncidentEvent(AuditEventType.INCIDENT_RESOLVED, data),
    );

    // Escalation events
    this.eventEmitter.on('escalation.started', (data: Record<string, unknown>) =>
      this.logEscalationEvent(AuditEventType.ESCALATION_STARTED, data),
    );
    this.eventEmitter.on('escalation.level.changed', (data: Record<string, unknown>) =>
      this.logEscalationEvent(AuditEventType.ESCALATION_LEVEL_CHANGED, data),
    );

    // Notification events
    this.eventEmitter.on('notification.sent', (data: Record<string, unknown>) =>
      this.logNotificationEvent(AuditEventType.NOTIFICATION_SENT, data),
    );
    this.eventEmitter.on('notification.failed', (data: Record<string, unknown>) =>
      this.logNotificationEvent(AuditEventType.NOTIFICATION_FAILED, data),
    );

    // Acknowledgment events
    this.eventEmitter.on('ack.acknowledged', (data: Record<string, unknown>) =>
      this.logAckEvent(AuditEventType.ACK_RECEIVED, data),
    );
    this.eventEmitter.on('ack.expired', (data: Record<string, unknown>) =>
      this.logAckEvent(AuditEventType.ACK_EXPIRED, data),
    );
  }

  /**
   * Log an audit entry
   */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const fullEntry: AuditEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      correlationId: this.getCurrentCorrelationId(),
      ...entry,
    };

    // Add to in-memory storage
    this.entries.push(fullEntry);

    // Trim if too large - shift oldest entries instead of O(n) splice
    while (this.entries.length > this.maxEntriesInMemory) {
      this.entries.shift();
    }

    // Update metrics
    this.updateMetrics(fullEntry);

    // Emit event for external handlers
    this.eventEmitter.emit('audit.logged', fullEntry);

    // Log critical/error entries
    if (fullEntry.severity === AuditSeverity.CRITICAL) {
      this.logger.error(`AUDIT: ${fullEntry.description}`, fullEntry);
    } else if (fullEntry.severity === AuditSeverity.ERROR) {
      this.logger.error(`AUDIT: ${fullEntry.description}`);
    }

    return fullEntry;
  }

  /**
   * Log a rule event
   */
  private logRuleEvent(eventType: AuditEventType, data: Record<string, unknown>): void {
    this.log({
      category: AuditCategory.RULE,
      eventType,
      severity: this.getSeverityForEventType(eventType),
      entityType: 'AlertRule',
      entityId: data.ruleId as string,
      tenantId: data.tenantId as string,
      userId: data.userId as string,
      action: eventType.toLowerCase().replace('rule_', ''),
      description: this.generateDescription(eventType, data),
      previousState: data.previousState as Record<string, unknown>,
      newState: data.newState as Record<string, unknown>,
      changes: data.changes as AuditChange[],
      metadata: data,
      success: true,
    });
  }

  /**
   * Log an incident event
   */
  private logIncidentEvent(eventType: AuditEventType, data: Record<string, unknown>): void {
    this.log({
      category: AuditCategory.INCIDENT,
      eventType,
      severity: this.getSeverityForEventType(eventType),
      entityType: 'AlertIncident',
      entityId: data.incidentId as string,
      tenantId: data.tenantId as string,
      userId: data.userId as string,
      action: eventType.toLowerCase().replace('incident_', ''),
      description: this.generateDescription(eventType, data),
      previousState: data.previousState as Record<string, unknown>,
      newState: data.newState as Record<string, unknown>,
      metadata: data,
      success: true,
    });
  }

  /**
   * Log an escalation event
   */
  private logEscalationEvent(eventType: AuditEventType, data: Record<string, unknown>): void {
    this.log({
      category: AuditCategory.ESCALATION,
      eventType,
      severity: this.getSeverityForEventType(eventType),
      entityType: 'Escalation',
      entityId: data.escalationId as string || data.incidentId as string,
      tenantId: data.tenantId as string,
      action: eventType.toLowerCase().replace('escalation_', ''),
      description: this.generateDescription(eventType, data),
      metadata: data,
      success: true,
    });
  }

  /**
   * Log a notification event
   */
  private logNotificationEvent(eventType: AuditEventType, data: Record<string, unknown>): void {
    const success = eventType !== AuditEventType.NOTIFICATION_FAILED;
    this.log({
      category: AuditCategory.NOTIFICATION,
      eventType,
      severity: success ? AuditSeverity.INFO : AuditSeverity.ERROR,
      entityType: 'Notification',
      entityId: data.notificationId as string,
      tenantId: data.tenantId as string,
      action: eventType.toLowerCase().replace('notification_', ''),
      description: this.generateDescription(eventType, data),
      metadata: data,
      success,
      errorMessage: data.error as string,
    });
  }

  /**
   * Log an acknowledgment event
   */
  private logAckEvent(eventType: AuditEventType, data: Record<string, unknown>): void {
    this.log({
      category: AuditCategory.ACKNOWLEDGMENT,
      eventType,
      severity: this.getSeverityForEventType(eventType),
      entityType: 'Acknowledgment',
      entityId: data.recordId as string,
      tenantId: data.tenantId as string,
      userId: data.acknowledgedBy as string || data.userId as string,
      action: eventType.toLowerCase().replace('ack_', ''),
      description: this.generateDescription(eventType, data),
      metadata: data,
      success: true,
    });
  }

  /**
   * Generate description for an event
   */
  private generateDescription(eventType: AuditEventType, data: Record<string, unknown>): string {
    switch (eventType) {
      case AuditEventType.RULE_CREATED:
        return `Rule '${data.ruleName || data.ruleId}' created`;
      case AuditEventType.RULE_UPDATED:
        return `Rule '${data.ruleName || data.ruleId}' updated`;
      case AuditEventType.RULE_DELETED:
        return `Rule '${data.ruleName || data.ruleId}' deleted`;
      case AuditEventType.RULE_TRIGGERED:
        return `Rule '${data.ruleName || data.ruleId}' triggered for metric value ${data.metricValue}`;
      case AuditEventType.INCIDENT_CREATED:
        return `Incident ${data.incidentId} created from rule '${data.ruleName}'`;
      case AuditEventType.INCIDENT_ACKNOWLEDGED:
        return `Incident ${data.incidentId} acknowledged by ${data.acknowledgedBy}`;
      case AuditEventType.INCIDENT_RESOLVED:
        return `Incident ${data.incidentId} resolved by ${data.resolvedBy}`;
      case AuditEventType.ESCALATION_STARTED:
        return `Escalation started for incident ${data.incidentId}`;
      case AuditEventType.ESCALATION_LEVEL_CHANGED:
        return `Escalation level changed to ${data.level} for incident ${data.incidentId}`;
      case AuditEventType.NOTIFICATION_SENT:
        return `Notification sent to ${data.recipient} via ${data.channel}`;
      case AuditEventType.NOTIFICATION_FAILED:
        return `Notification to ${data.recipient} via ${data.channel} failed: ${data.error}`;
      case AuditEventType.ACK_RECEIVED:
        return `Acknowledgment received for alert ${data.alertId}`;
      case AuditEventType.ACK_EXPIRED:
        return `Acknowledgment expired for alert ${data.alertId}`;
      default:
        return `${eventType}: ${JSON.stringify(data)}`;
    }
  }

  /**
   * Get severity for event type
   */
  private getSeverityForEventType(eventType: AuditEventType): AuditSeverity {
    switch (eventType) {
      case AuditEventType.ERROR:
      case AuditEventType.NOTIFICATION_FAILED:
      case AuditEventType.RULE_EVALUATION_FAILED:
        return AuditSeverity.ERROR;

      case AuditEventType.WARNING:
      case AuditEventType.ACK_EXPIRED:
      case AuditEventType.ESCALATION_TIMEOUT:
        return AuditSeverity.WARNING;

      case AuditEventType.RULE_TRIGGERED:
      case AuditEventType.INCIDENT_CREATED:
      case AuditEventType.ESCALATION_STARTED:
        return AuditSeverity.INFO;

      default:
        return AuditSeverity.INFO;
    }
  }

  /**
   * Start a correlation context.
   * PE-15: Uses AsyncLocalStorage so each async execution context gets its own
   * isolated correlation ID, preventing cross-request ID leakage.
   */
  startCorrelation(correlationId?: string): string {
    const id = correlationId || this.generateCorrelationId();
    this.correlationStorage.enterWith(id);
    return id;
  }

  /**
   * End current correlation context (no-op with AsyncLocalStorage - context ends
   * automatically when the async context exits).
   */
  endCorrelation(): void {
    // AsyncLocalStorage contexts are scoped to the async execution context;
    // no explicit cleanup is needed.
  }

  /**
   * Get current correlation ID
   */
  private getCurrentCorrelationId(): string | undefined {
    return this.correlationStorage.getStore();
  }

  /**
   * Query audit entries
   * PE-03: Build a predicate array and apply a single-pass filter rather than
   * starting with a full O(n) copy of the entire entries array.
   */
  query(options: AuditQueryOptions): AuditEntry[] {
    // Build predicates lazily so we do a single pass over entries.
    const predicates: Array<(e: AuditEntry) => boolean> = [];

    if (options.category) {
      predicates.push(e => e.category === options.category);
    }
    if (options.eventType) {
      predicates.push(e => e.eventType === options.eventType);
    }
    if (options.severity) {
      predicates.push(e => e.severity === options.severity);
    }
    if (options.entityType) {
      predicates.push(e => e.entityType === options.entityType);
    }
    if (options.entityId) {
      predicates.push(e => e.entityId === options.entityId);
    }
    if (options.tenantId) {
      predicates.push(e => e.tenantId === options.tenantId);
    }
    if (options.userId) {
      predicates.push(e => e.userId === options.userId);
    }
    if (options.startTime) {
      const st = options.startTime;
      predicates.push(e => e.timestamp >= st);
    }
    if (options.endTime) {
      const et = options.endTime;
      predicates.push(e => e.timestamp <= et);
    }
    if (options.correlationId) {
      predicates.push(e => e.correlationId === options.correlationId);
    }
    if (options.tags && options.tags.length > 0) {
      const tags = options.tags;
      predicates.push(e => !!(e.tags && tags.some(tag => e.tags!.includes(tag))));
    }
    if (options.success !== undefined) {
      predicates.push(e => e.success === options.success);
    }

    let results: AuditEntry[];
    if (predicates.length === 0) {
      results = [...this.entries];
    } else {
      results = this.entries.filter(e => predicates.every(p => p(e)));
    }

    // Sort
    const orderBy = options.orderBy || 'timestamp';
    const orderDirection = options.orderDirection || 'DESC';

    results.sort((a, b) => {
      let comparison = 0;
      if (orderBy === 'timestamp') {
        comparison = a.timestamp.getTime() - b.timestamp.getTime();
      } else if (orderBy === 'severity') {
        const severityOrder = [
          AuditSeverity.DEBUG,
          AuditSeverity.INFO,
          AuditSeverity.WARNING,
          AuditSeverity.ERROR,
          AuditSeverity.CRITICAL,
        ];
        comparison = severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
      }
      return orderDirection === 'DESC' ? -comparison : comparison;
    });

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || 100;

    return results.slice(offset, offset + limit);
  }

  /**
   * Get audit entry by ID
   */
  getById(id: string): AuditEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  /**
   * Get entries by correlation ID
   */
  getByCorrelationId(correlationId: string): AuditEntry[] {
    return this.entries.filter(e => e.correlationId === correlationId);
  }

  /**
   * Get entity history
   */
  getEntityHistory(entityType: string, entityId: string): AuditEntry[] {
    return this.entries
      .filter(e => e.entityType === entityType && e.entityId === entityId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get statistics
   */
  getStatistics(tenantId?: string, startTime?: Date, endTime?: Date): AuditStatistics {
    // PE-03: Single-pass filter instead of chained full-array copies.
    const entries = this.entries.filter(e => {
      if (tenantId && e.tenantId !== tenantId) return false;
      if (startTime && e.timestamp < startTime) return false;
      if (endTime && e.timestamp > endTime) return false;
      return true;
    });

    // Calculate statistics
    const entriesByCategory: Record<string, number> = {};
    const entriesBySeverity: Record<string, number> = {};
    const entriesByEventType: Record<string, number> = {};
    const userCounts = new Map<string, number>();
    const entityCounts = new Map<string, number>();
    let successCount = 0;
    let failureCount = 0;

    for (const entry of entries) {
      entriesByCategory[entry.category] = (entriesByCategory[entry.category] || 0) + 1;
      entriesBySeverity[entry.severity] = (entriesBySeverity[entry.severity] || 0) + 1;
      entriesByEventType[entry.eventType] = (entriesByEventType[entry.eventType] || 0) + 1;

      if (entry.userId) {
        userCounts.set(entry.userId, (userCounts.get(entry.userId) || 0) + 1);
      }

      if (entry.entityId) {
        entityCounts.set(entry.entityId, (entityCounts.get(entry.entityId) || 0) + 1);
      }

      if (entry.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    // Calculate average entries per day
    const dayMs = 24 * 60 * 60 * 1000;
    const lastEntry = entries[entries.length - 1];
    const firstEntry = entries[0];
    const timeRange = entries.length > 0 && lastEntry && firstEntry
      ? lastEntry.timestamp.getTime() - firstEntry.timestamp.getTime()
      : 0;
    const days = Math.max(1, timeRange / dayMs);
    const averageEntriesPerDay = entries.length / days;

    // Top users
    const topUsers = Array.from(userCounts.entries())
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Top entities
    const topEntities = Array.from(entityCounts.entries())
      .map(([entityId, count]) => ({ entityId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Recent errors
    const recentErrors = entries
      .filter(e => e.severity === AuditSeverity.ERROR || e.severity === AuditSeverity.CRITICAL)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 10);

    return {
      totalEntries: entries.length,
      entriesByCategory,
      entriesBySeverity,
      entriesByEventType,
      successRate: entries.length > 0 ? successCount / entries.length : 1,
      averageEntriesPerDay,
      topUsers,
      topEntities,
      recentErrors,
    };
  }

  /**
   * Generate audit report
   */
  generateReport(config: AuditReportConfig): AuditReport {
    // Query entries
    let entries = this.query({
      startTime: config.startTime,
      endTime: config.endTime,
      limit: config.maxEntries || 10000,
    });

    // Filter by categories if specified
    if (config.categories && config.categories.length > 0) {
      entries = entries.filter(e => config.categories!.includes(e.category));
    }

    // Filter by severities if specified
    if (config.severities && config.severities.length > 0) {
      entries = entries.filter(e => config.severities!.includes(e.severity));
    }

    // Remove changes if not requested
    if (!config.includeChanges) {
      entries = entries.map(e => ({ ...e, changes: undefined, previousState: undefined, newState: undefined }));
    }

    // Calculate summary
    const summary = {
      totalEntries: entries.length,
      successCount: entries.filter(e => e.success).length,
      failureCount: entries.filter(e => !e.success).length,
      byCategory: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
    };

    for (const entry of entries) {
      summary.byCategory[entry.category] = (summary.byCategory[entry.category] || 0) + 1;
      summary.bySeverity[entry.severity] = (summary.bySeverity[entry.severity] || 0) + 1;
    }

    // Group data if requested
    let groupedData: Record<string, AuditEntry[]> | undefined;
    if (config.groupBy) {
      groupedData = {};
      for (const entry of entries) {
        let key: string;
        switch (config.groupBy) {
          case 'category':
            key = entry.category;
            break;
          case 'eventType':
            key = entry.eventType;
            break;
          case 'user':
            key = entry.userId || 'unknown';
            break;
          case 'entity':
            key = entry.entityId || 'unknown';
            break;
          case 'day':
            key = entry.timestamp.toISOString().split('T')[0] ?? 'unknown';
            break;
          default:
            key = 'all';
        }
        if (!groupedData![key]) {
          groupedData![key] = [];
        }
        groupedData![key]!.push(entry);
      }
    }

    return {
      title: config.title,
      generatedAt: new Date(),
      period: {
        start: config.startTime,
        end: config.endTime,
      },
      summary,
      entries,
      groupedData,
    };
  }

  /**
   * Export entries to JSON
   */
  exportToJson(options?: AuditQueryOptions): string {
    const entries = options ? this.query(options) : this.entries;
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Clear old entries
   */
  clearOldEntries(olderThanDays: number = 90): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const initialLength = this.entries.length;
    const filtered = this.entries.filter(e => e.timestamp >= cutoff);

    this.entries.length = 0;
    this.entries.push(...filtered);

    const deletedCount = initialLength - this.entries.length;

    if (deletedCount > 0) {
      this.logger.log(`Cleared ${deletedCount} audit entries older than ${olderThanDays} days`);
    }

    return deletedCount;
  }

  /**
   * Update metrics
   */
  private updateMetrics(entry: AuditEntry): void {
    this.metrics.totalLogged++;

    this.metrics.byCategory.set(
      entry.category,
      (this.metrics.byCategory.get(entry.category) || 0) + 1,
    );

    this.metrics.bySeverity.set(
      entry.severity,
      (this.metrics.bySeverity.get(entry.severity) || 0) + 1,
    );

    this.metrics.byEventType.set(
      entry.eventType,
      (this.metrics.byEventType.get(entry.eventType) || 0) + 1,
    );

    if (entry.success) {
      this.metrics.successCount++;
    } else {
      this.metrics.failureCount++;
    }
  }

  /**
   * Get metrics
   */
  getMetrics(): {
    totalLogged: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    byEventType: Record<string, number>;
    successRate: number;
  } {
    return {
      totalLogged: this.metrics.totalLogged,
      byCategory: Object.fromEntries(this.metrics.byCategory),
      bySeverity: Object.fromEntries(this.metrics.bySeverity),
      byEventType: Object.fromEntries(this.metrics.byEventType),
      successRate:
        this.metrics.totalLogged > 0
          ? this.metrics.successCount / this.metrics.totalLogged
          : 1,
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `audit_${crypto.randomUUID()}`;
  }

  /**
   * Generate correlation ID
   */
  private generateCorrelationId(): string {
    return `corr_${crypto.randomUUID()}`;
  }

  /**
   * Log user action
   */
  logUserAction(
    userId: string,
    action: string,
    description: string,
    metadata?: Record<string, unknown>,
  ): AuditEntry {
    return this.log({
      category: AuditCategory.USER_ACTION,
      eventType: AuditEventType.USER_ACTION,
      severity: AuditSeverity.INFO,
      userId,
      action,
      description,
      metadata,
      success: true,
    });
  }

  /**
   * Log configuration change
   */
  logConfigChange(
    configKey: string,
    previousValue: unknown,
    newValue: unknown,
    userId?: string,
  ): AuditEntry {
    return this.log({
      category: AuditCategory.CONFIGURATION,
      eventType: AuditEventType.CONFIG_CHANGED,
      severity: AuditSeverity.INFO,
      entityType: 'Configuration',
      entityId: configKey,
      userId,
      action: 'config_changed',
      description: `Configuration '${configKey}' changed`,
      previousState: { value: previousValue },
      newState: { value: newValue },
      changes: [
        {
          field: configKey,
          previousValue,
          newValue,
        },
      ],
      success: true,
    });
  }

  /**
   * Log error
   * NOTE: Full stack traces are intentionally excluded from audit metadata to prevent
   * internal system structure disclosure. Stack traces are forwarded to the server-side
   * logger only.
   */
  logError(
    error: Error,
    context?: Record<string, unknown>,
    entityType?: string,
    entityId?: string,
  ): AuditEntry {
    // Log the full stack trace server-side only — never store it in the audit record.
    this.logger.error(`[logError] ${error.message}`, error.stack);

    return this.log({
      category: AuditCategory.SYSTEM,
      eventType: AuditEventType.ERROR,
      severity: AuditSeverity.ERROR,
      entityType,
      entityId,
      action: 'error',
      description: error.message,
      metadata: {
        ...context,
        // Omit error.stack — stack traces contain internal file paths and module names.
        name: error.name,
      },
      success: false,
      errorMessage: error.message,
    });
  }
}
