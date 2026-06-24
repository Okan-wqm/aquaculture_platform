/**
 * Alert Audit Service
 *
 * Comprehensive audit logging for all alert-related operations.
 * Tracks rule changes, incident lifecycle, escalations, notifications, and user actions.
 *
 * Persists audit entries to PostgreSQL via TypeORM. Falls back to in-memory
 * storage when database writes fail to avoid losing audit data during transient
 * DB outages. In-memory entries are flushed to the database on the next
 * successful write cycle.
 */

import * as crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditEntryEntity } from './entities/audit-entry.entity';

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

  /**
   * In-memory fallback buffer for entries that failed to persist to the database.
   * Capped at 2000 to bound heap usage. Entries are flushed to the DB on the
   * next successful write cycle.
   */
  private readonly fallbackEntries: AuditEntry[] = [];
  private readonly maxFallbackEntries = 2000;

  // PE-15: Use AsyncLocalStorage for request-scoped correlation IDs.
  private readonly correlationStorage = new AsyncLocalStorage<string>();

  // Metrics (kept in-memory for fast access)
  private metrics = {
    totalLogged: 0,
    byCategory: new Map<string, number>(),
    bySeverity: new Map<string, number>(),
    byEventType: new Map<string, number>(),
    successCount: 0,
    failureCount: 0,
  };

  constructor(
    @InjectRepository(AuditEntryEntity)
    private readonly auditRepository: Repository<AuditEntryEntity>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.setupEventListeners();
    // NOTE: Do NOT persist a SYSTEM_STARTED audit entry to the database here.
    // At module-init time there is no tenant context, so the repository targets
    // the template schema ("alert").  Writing rows to the template schema causes
    // SOURCE_CONTAMINATION watchdog violations.  A console log is sufficient for
    // service-lifecycle events.
    this.logger.log('AlertAuditService initialized with PostgreSQL persistence');
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
   * Log an audit entry.
   * Persists to PostgreSQL. On DB failure, stores in the in-memory fallback buffer.
   */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const fullEntry: AuditEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      correlationId: this.getCurrentCorrelationId(),
      ...entry,
    };

    // Update metrics synchronously
    this.updateMetrics(fullEntry);

    // Persist to database asynchronously; persistEntry owns DB fallback handling.
    void this.persistEntry(fullEntry);

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
   * Persist an audit entry to the database.
   * On failure, push to the in-memory fallback buffer.
   */
  private async persistEntry(entry: AuditEntry): Promise<void> {
    try {
      // First, try to flush any pending fallback entries
      await this.flushFallbackEntries();

      // Save the current entry
      const entity = this.toEntity(entry);
      await this.auditRepository.save(entity);
    } catch (error) {
      this.logger.warn(
        `Failed to persist audit entry to DB, using in-memory fallback: ${(error as Error).message}`,
      );

      // In-memory fallback
      this.fallbackEntries.push(entry);
      while (this.fallbackEntries.length > this.maxFallbackEntries) {
        this.fallbackEntries.shift();
      }
    }
  }

  /**
   * Attempt to flush in-memory fallback entries to the database.
   */
  private async flushFallbackEntries(): Promise<void> {
    if (this.fallbackEntries.length === 0) return;

    try {
      const entities = this.fallbackEntries.map(e => this.toEntity(e));
      await this.auditRepository.save(entities);
      this.fallbackEntries.length = 0;
      this.logger.log(`Flushed ${entities.length} fallback audit entries to database`);
    } catch {
      // Silently keep entries in the fallback buffer for next attempt
    }
  }

  /**
   * Convert AuditEntry interface to AuditEntryEntity for persistence.
   */
  private toEntity(entry: AuditEntry): AuditEntryEntity {
    const entity = new AuditEntryEntity();
    entity.id = entry.id.replace('audit_', ''); // strip prefix for UUID column
    entity.tenantId = entry.tenantId;
    entity.category = entry.category;
    entity.eventType = entry.eventType;
    entity.severity = entry.severity;
    entity.action = entry.action;
    entity.description = entry.description;
    entity.entityType = entry.entityType;
    entity.entityId = entry.entityId;
    entity.userId = entry.userId;
    entity.userName = entry.userName;
    entity.ipAddress = entry.ipAddress;
    entity.userAgent = entry.userAgent;
    entity.previousState = entry.previousState;
    entity.newState = entry.newState;
    entity.changes = entry.changes;
    entity.metadata = entry.metadata;
    entity.correlationId = entry.correlationId;
    entity.parentAuditId = entry.parentAuditId;
    entity.tags = entry.tags;
    entity.duration = entry.duration;
    entity.success = entry.success;
    entity.errorMessage = entry.errorMessage;
    entity.timestamp = entry.timestamp;
    return entity;
  }

  /**
   * Convert AuditEntryEntity to AuditEntry interface.
   */
  private toAuditEntry(entity: AuditEntryEntity): AuditEntry {
    return {
      id: `audit_${entity.id}`,
      category: entity.category as AuditCategory,
      eventType: entity.eventType as AuditEventType,
      severity: entity.severity as AuditSeverity,
      timestamp: entity.timestamp,
      entityType: entity.entityType,
      entityId: entity.entityId,
      tenantId: entity.tenantId,
      userId: entity.userId,
      userName: entity.userName,
      ipAddress: entity.ipAddress,
      userAgent: entity.userAgent,
      action: entity.action,
      description: entity.description,
      previousState: entity.previousState,
      newState: entity.newState,
      changes: entity.changes,
      metadata: entity.metadata,
      correlationId: entity.correlationId,
      parentAuditId: entity.parentAuditId,
      tags: entity.tags,
      duration: entity.duration,
      success: entity.success,
      errorMessage: entity.errorMessage,
    };
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
   */
  startCorrelation(correlationId?: string): string {
    const id = correlationId || this.generateCorrelationId();
    this.correlationStorage.enterWith(id);
    return id;
  }

  /**
   * End current correlation context (no-op with AsyncLocalStorage).
   */
  endCorrelation(): void {
    // AsyncLocalStorage contexts are scoped to the async execution context.
  }

  /**
   * Get current correlation ID
   */
  private getCurrentCorrelationId(): string | undefined {
    return this.correlationStorage.getStore();
  }

  /**
   * Query audit entries from the database with pagination.
   */
  async query(options: AuditQueryOptions): Promise<AuditEntry[]> {
    const qb = this.auditRepository.createQueryBuilder('audit');

    if (options.category) {
      qb.andWhere('audit.category = :category', { category: options.category });
    }
    if (options.eventType) {
      qb.andWhere('audit.event_type = :eventType', { eventType: options.eventType });
    }
    if (options.severity) {
      qb.andWhere('audit.severity = :severity', { severity: options.severity });
    }
    if (options.entityType) {
      qb.andWhere('audit.entity_type = :entityType', { entityType: options.entityType });
    }
    if (options.entityId) {
      qb.andWhere('audit.entity_id = :entityId', { entityId: options.entityId });
    }
    if (options.tenantId) {
      qb.andWhere('audit.tenant_id = :tenantId', { tenantId: options.tenantId });
    }
    if (options.userId) {
      qb.andWhere('audit.user_id = :userId', { userId: options.userId });
    }
    if (options.startTime) {
      qb.andWhere('audit.timestamp >= :startTime', { startTime: options.startTime });
    }
    if (options.endTime) {
      qb.andWhere('audit.timestamp <= :endTime', { endTime: options.endTime });
    }
    if (options.correlationId) {
      qb.andWhere('audit.correlation_id = :correlationId', { correlationId: options.correlationId });
    }
    if (options.success !== undefined) {
      qb.andWhere('audit.success = :success', { success: options.success });
    }

    // Sort
    const orderBy = options.orderBy || 'timestamp';
    const orderDirection = options.orderDirection || 'DESC';
    qb.orderBy(`audit.${orderBy === 'timestamp' ? 'timestamp' : 'severity'}`, orderDirection);

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || 100;
    qb.skip(offset).take(limit);

    const entities = await qb.getMany();
    return entities.map(e => this.toAuditEntry(e));
  }

  /**
   * Get audit entry by ID
   */
  async getById(id: string, tenantId: string): Promise<AuditEntry | undefined> {
    const uuid = id.replace('audit_', '');
    const entity = await this.auditRepository.findOne({ where: { id: uuid, tenantId } });
    return entity ? this.toAuditEntry(entity) : undefined;
  }

  /**
   * Get entries by correlation ID
   */
  async getByCorrelationId(correlationId: string, tenantId: string): Promise<AuditEntry[]> {
    const entities = await this.auditRepository.find({
      where: { correlationId, tenantId },
      order: { timestamp: 'ASC' },
    });
    return entities.map(e => this.toAuditEntry(e));
  }

  /**
   * Get entity history
   */
  async getEntityHistory(entityType: string, entityId: string, tenantId: string): Promise<AuditEntry[]> {
    const entities = await this.auditRepository.find({
      where: { entityType, entityId, tenantId },
      order: { timestamp: 'DESC' },
    });
    return entities.map(e => this.toAuditEntry(e));
  }

  /**
   * Get statistics.
   * Queries the database for aggregate data.
   */
  async getStatistics(tenantId?: string, startTime?: Date, endTime?: Date): Promise<AuditStatistics> {
    const qb = this.auditRepository.createQueryBuilder('audit');

    if (tenantId) {
      qb.andWhere('audit.tenant_id = :tenantId', { tenantId });
    }
    if (startTime) {
      qb.andWhere('audit.timestamp >= :startTime', { startTime });
    }
    if (endTime) {
      qb.andWhere('audit.timestamp <= :endTime', { endTime });
    }

    const entries = await qb.getMany();

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
      .slice(0, 10)
      .map(e => this.toAuditEntry(e));

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
  async generateReport(config: AuditReportConfig): Promise<AuditReport> {
    // Query entries
    let entries = await this.query({
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
  async exportToJson(options?: AuditQueryOptions): Promise<string> {
    const entries = options ? await this.query(options) : await this.query({ limit: 10000 });
    return JSON.stringify(entries);
  }

  /**
   * Clear old entries from the database
   */
  async clearOldEntries(olderThanDays: number = 90): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await this.auditRepository.delete({
      timestamp: LessThan(cutoff),
    });

    const deletedCount = result.affected || 0;

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
    pendingFallbackEntries: number;
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
      pendingFallbackEntries: this.fallbackEntries.length,
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
    // Log the full stack trace server-side only -- never store it in the audit record.
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
        name: error.name,
      },
      success: false,
      errorMessage: error.message,
    });
  }
}
