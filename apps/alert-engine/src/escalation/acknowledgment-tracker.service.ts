/**
 * Acknowledgment Tracker Service
 *
 * Tracks and manages acknowledgment states for alerts and incidents.
 * Handles ack timeouts, ack escalation, and ack-related workflows.
 *
 * All state is persisted in Redis so that acknowledgment data survives
 * container restarts (D10-F4 fix).
 */

import * as crypto from 'crypto';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isValidUUID } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';

/**
 * Acknowledgment status
 */
export enum AckStatus {
  PENDING = 'PENDING',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  EXPIRED = 'EXPIRED',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
}

/**
 * Acknowledgment source type
 */
export enum AckSourceType {
  MANUAL = 'MANUAL',
  AUTO = 'AUTO',
  API = 'API',
  INTEGRATION = 'INTEGRATION',
  SCHEDULE = 'SCHEDULE',
}

/**
 * Acknowledgment record
 */
export interface AcknowledgmentRecord {
  id: string;
  tenantId: string;
  alertId: string;
  incidentId?: string;
  status: AckStatus;
  sourceType: AckSourceType;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  expiresAt?: Date;
  message?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  escalationLevel: number;
  timeoutCount: number;
  history: AckHistoryEntry[];
}

/**
 * History entry for acknowledgment
 */
export interface AckHistoryEntry {
  timestamp: Date;
  previousStatus: AckStatus;
  newStatus: AckStatus;
  action: string;
  performedBy?: string;
  reason?: string;
}

/**
 * Acknowledgment timeout configuration
 */
export interface AckTimeoutConfig {
  initialTimeoutMs: number;
  maxTimeouts: number;
  timeoutEscalationMs: number;
  autoResolveOnTimeout: boolean;
  notifyOnTimeout: boolean;
  escalateOnTimeout: boolean;
}

/**
 * Ack request options
 */
export interface AckRequestOptions {
  userId: string;
  message?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  sourceType?: AckSourceType;
}

/**
 * Pending acknowledgment with timeout info
 */
interface PendingAck {
  recordId: string;
  timeoutAt: number;
  escalationLevel: number;
}

/**
 * Acknowledgment statistics
 */
export interface AckStatistics {
  totalAcks: number;
  pendingAcks: number;
  acknowledgedCount: number;
  expiredCount: number;
  escalatedCount: number;
  resolvedCount: number;
  averageAckTimeMs: number;
  averageTimeoutsBeforeAck: number;
}

/**
 * Redis key prefixes for acknowledgment state
 */
const REDIS_KEYS = {
  /** Set of tenants with active ack state. Contains tenant identifiers only. */
  TENANTS: 'ack:tenants',
  /** Tenant namespace prefix: ack:tenant:{tenantId}:... */
  TENANT_PREFIX: 'ack:tenant:',
  /** Individual ack record suffix: record:{id} */
  RECORD: 'record:',
  /** Alert-to-record mapping suffix: alert:{alertId} -> recordId */
  ALERT_MAP: 'alert:',
  /** Pending ack info suffix: pending:{recordId} */
  PENDING: 'pending:',
  /** Set of pending record IDs for one tenant */
  PENDING_SET: 'pending_set',
  /** Metrics counters */
  METRICS: 'metrics',
  /** Ack time samples for average calculation */
  METRICS_ACK_TIMES: 'metrics:ack_times',
  /** Timeout count samples for average calculation */
  METRICS_TIMEOUT_COUNTS: 'metrics:timeout_counts',
};

/**
 * TTL for completed/expired/resolved ack records: 24 hours
 */
const COMPLETED_RECORD_TTL_SECONDS = 24 * 60 * 60;

/**
 * TTL for active (pending/escalated) ack records: 7 days
 * Acts as a safety net -- active records should be resolved/expired before this.
 */
const ACTIVE_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class AcknowledgmentTrackerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AcknowledgmentTrackerService.name);

  private timeoutChecker: NodeJS.Timeout | null = null;

  private defaultConfig: AckTimeoutConfig = {
    initialTimeoutMs: 5 * 60 * 1000, // 5 minutes
    maxTimeouts: 3,
    timeoutEscalationMs: 10 * 60 * 1000, // 10 minutes
    autoResolveOnTimeout: false,
    notifyOnTimeout: true,
    escalateOnTimeout: true,
  };

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly redisService: RedisService,
  ) {}

  private assertTenantId(tenantId: string): void {
    if (!isValidUUID(tenantId)) {
      throw new Error(`Invalid tenantId for acknowledgment Redis key: ${tenantId}`);
    }
  }

  private tenantPrefix(tenantId: string): string {
    this.assertTenantId(tenantId);
    return `${REDIS_KEYS.TENANT_PREFIX}${tenantId}:`;
  }

  private recordKey(tenantId: string, recordId: string): string {
    return `${this.tenantPrefix(tenantId)}${REDIS_KEYS.RECORD}${recordId}`;
  }

  private recordPattern(tenantId: string): string {
    return `${this.tenantPrefix(tenantId)}${REDIS_KEYS.RECORD}*`;
  }

  private alertMapKey(tenantId: string, alertId: string): string {
    return `${this.tenantPrefix(tenantId)}${REDIS_KEYS.ALERT_MAP}${alertId}`;
  }

  private pendingKey(tenantId: string, recordId: string): string {
    return `${this.tenantPrefix(tenantId)}${REDIS_KEYS.PENDING}${recordId}`;
  }

  private pendingSetKey(tenantId: string): string {
    return `${this.tenantPrefix(tenantId)}${REDIS_KEYS.PENDING_SET}`;
  }

  private metricsKey(tenantId: string): string {
    return `${this.tenantPrefix(tenantId)}${REDIS_KEYS.METRICS}`;
  }

  private metricSampleKey(tenantId: string, suffix: string): string {
    return `${this.tenantPrefix(tenantId)}${suffix}`;
  }

  private extractRecordId(tenantId: string, key: string): string {
    return key.slice(`${this.tenantPrefix(tenantId)}${REDIS_KEYS.RECORD}`.length);
  }

  private async registerTenant(tenantId: string): Promise<void> {
    this.assertTenantId(tenantId);
    await this.redisService.sadd(REDIS_KEYS.TENANTS, tenantId);
  }

  private async getRegisteredTenants(): Promise<string[]> {
    return this.redisService.smembers(REDIS_KEYS.TENANTS);
  }

  async onModuleInit(): Promise<void> {
    // Start timeout checker
    this.timeoutChecker = setInterval(
      () => {
        void this.checkTimeouts().catch((error) => {
          this.logger.error('Ack timeout checker failed', error);
        });
      },
      10000, // Check every 10 seconds
    );

    this.logger.log('AcknowledgmentTrackerService initialized (Redis-backed)');
  }

  onModuleDestroy(): void {
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Redis helpers with graceful degradation
  // ---------------------------------------------------------------------------

  /**
   * Save an AcknowledgmentRecord to Redis.
   * Uses setJson for simplicity; the entire record is serialized as JSON.
   */
  private async saveRecord(record: AcknowledgmentRecord): Promise<void> {
    try {
      const isTerminal =
        record.status === AckStatus.RESOLVED || record.status === AckStatus.EXPIRED;
      const ttl = isTerminal ? COMPLETED_RECORD_TTL_SECONDS : ACTIVE_RECORD_TTL_SECONDS;

      await this.redisService.setJson(this.recordKey(record.tenantId, record.id), record, ttl);
    } catch (error) {
      this.logger.error(`Failed to save ack record ${record.id} to Redis`, error);
      throw error;
    }
  }

  /**
   * Load an AcknowledgmentRecord from Redis and rehydrate Date fields.
   */
  private async loadRecord(tenantId: string, recordId: string): Promise<AcknowledgmentRecord | null> {
    try {
      const raw = await this.redisService.getJson<AcknowledgmentRecord>(
        this.recordKey(tenantId, recordId),
      );
      if (!raw) return null;
      return this.rehydrateDates(raw);
    } catch (error) {
      this.logger.error(`Failed to load ack record ${recordId} from Redis`, error);
      return null;
    }
  }

  /**
   * Delete an AcknowledgmentRecord from Redis.
   */
  private async deleteRecordFromRedis(tenantId: string, recordId: string): Promise<void> {
    try {
      await this.redisService.del(this.recordKey(tenantId, recordId));
    } catch (error) {
      this.logger.error(`Failed to delete ack record ${recordId} from Redis`, error);
      throw error;
    }
  }

  /**
   * Save the alert-to-record mapping to Redis.
   */
  private async saveAlertMapping(tenantId: string, alertId: string, recordId: string): Promise<void> {
    try {
      await this.redisService.set(
        this.alertMapKey(tenantId, alertId),
        recordId,
        ACTIVE_RECORD_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.error(`Failed to save alert mapping for ${alertId}`, error);
      throw error;
    }
  }

  /**
   * Get the record ID mapped to an alert ID.
   */
  private async getRecordIdByAlertId(tenantId: string, alertId: string): Promise<string | null> {
    try {
      return await this.redisService.get(this.alertMapKey(tenantId, alertId));
    } catch (error) {
      this.logger.error(`Failed to get alert mapping for ${alertId}`, error);
      return null;
    }
  }

  /**
   * Delete the alert mapping.
   */
  private async deleteAlertMapping(tenantId: string, alertId: string): Promise<void> {
    try {
      await this.redisService.del(this.alertMapKey(tenantId, alertId));
    } catch (error) {
      this.logger.error(`Failed to delete alert mapping for ${alertId}`, error);
      throw error;
    }
  }

  /**
   * Save pending ack info to Redis and add to the pending set.
   */
  private async savePendingAck(tenantId: string, pending: PendingAck): Promise<void> {
    try {
      await this.redisService.setJson(
        this.pendingKey(tenantId, pending.recordId),
        pending,
        ACTIVE_RECORD_TTL_SECONDS,
      );
      await this.redisService.sadd(this.pendingSetKey(tenantId), pending.recordId);
    } catch (error) {
      this.logger.error(`Failed to save pending ack ${pending.recordId}`, error);
      throw error;
    }
  }

  /**
   * Remove a pending ack from Redis and the pending set.
   */
  private async removePendingAck(tenantId: string, recordId: string): Promise<void> {
    try {
      await this.redisService.del(this.pendingKey(tenantId, recordId));
      await this.redisService.srem(this.pendingSetKey(tenantId), recordId);
    } catch (error) {
      this.logger.error(`Failed to remove pending ack ${recordId}`, error);
      throw error;
    }
  }

  /**
   * Load all pending ack entries from Redis.
   */
  private async loadAllPendingAcks(tenantId: string): Promise<PendingAck[]> {
    try {
      const memberIds = await this.redisService.smembers(this.pendingSetKey(tenantId));
      if (!memberIds || memberIds.length === 0) return [];

      const results = await Promise.all(
        memberIds.map(async (id) => {
          const pending = await this.redisService.getJson<PendingAck>(
            this.pendingKey(tenantId, id),
          );
          return pending;
        }),
      );

      return results.filter((p): p is PendingAck => p !== null);
    } catch (error) {
      this.logger.error('Failed to load pending acks from Redis', error);
      return [];
    }
  }

  /**
   * Increment a metrics counter in Redis.
   */
  private async incrementMetric(tenantId: string, field: string): Promise<void> {
    try {
      const key = this.metricsKey(tenantId);
      await this.redisService.hset(key, field, '0'); // ensure key exists
      const current = await this.redisService.hget(key, field);
      const next = (parseInt(current || '0', 10) + 1).toString();
      await this.redisService.hset(key, field, next);
    } catch (error) {
      this.logger.error(`Failed to increment metric ${field}`, error);
    }
  }

  /**
   * Append a value to a Redis list used for metrics samples (capped at 1000).
   */
  private async appendMetricSample(tenantId: string, listKey: string, value: number): Promise<void> {
    try {
      const prefixedKey = this.metricSampleKey(tenantId, listKey);
      await this.redisService.rpush(prefixedKey, value.toString());
      await this.redisService.ltrim(prefixedKey, -1000, -1); // keep last 1000
    } catch (error) {
      this.logger.error(`Failed to append metric sample to ${listKey}`, error);
    }
  }

  /**
   * Rehydrate Date fields from JSON (they arrive as strings from Redis).
   */
  private rehydrateDates(raw: AcknowledgmentRecord): AcknowledgmentRecord {
    return {
      ...raw,
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
      acknowledgedAt: raw.acknowledgedAt ? new Date(raw.acknowledgedAt) : undefined,
      expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : undefined,
      history: (raw.history || []).map((h) => ({
        ...h,
        timestamp: new Date(h.timestamp),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * Update default configuration
   */
  updateConfig(config: Partial<AckTimeoutConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
    this.logger.debug('Ack timeout configuration updated');
  }

  /**
   * Get current configuration
   */
  getConfig(): AckTimeoutConfig {
    return { ...this.defaultConfig };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new acknowledgment tracking record
   */
  async createRecord(
    tenantId: string,
    alertId: string,
    incidentId?: string,
    config?: Partial<AckTimeoutConfig>,
  ): Promise<AcknowledgmentRecord> {
    const id = this.generateId();
    const effectiveConfig = { ...this.defaultConfig, ...config };

    const record: AcknowledgmentRecord = {
      id,
      tenantId,
      alertId,
      incidentId,
      status: AckStatus.PENDING,
      sourceType: AckSourceType.MANUAL,
      createdAt: new Date(),
      updatedAt: new Date(),
      escalationLevel: 0,
      timeoutCount: 0,
      history: [
        {
          timestamp: new Date(),
          previousStatus: AckStatus.PENDING,
          newStatus: AckStatus.PENDING,
          action: 'created',
        },
      ],
    };

    // Calculate initial timeout
    const timeoutAt = Date.now() + effectiveConfig.initialTimeoutMs;

    await this.registerTenant(tenantId);
    await this.saveRecord(record);
    await this.saveAlertMapping(tenantId, alertId, id);
    await this.savePendingAck(tenantId, {
      recordId: id,
      timeoutAt,
      escalationLevel: 0,
    });

    await this.incrementMetric(tenantId, 'totalCreated');

    this.eventEmitter.emit('ack.created', {
      recordId: id,
      tenantId,
      alertId,
      incidentId,
      timeoutAt: new Date(timeoutAt),
    });

    this.logger.debug(`Created ack record ${id} for alert ${alertId}`);
    return record;
  }

  /**
   * Acknowledge an alert
   */
  async acknowledge(
    tenantId: string,
    alertId: string,
    options: AckRequestOptions,
  ): Promise<AcknowledgmentRecord> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = await this.loadRecord(tenantId, recordId);
    if (!record) {
      throw new Error(`Acknowledgment record not found: ${recordId}`);
    }

    if (record.status !== AckStatus.PENDING && record.status !== AckStatus.ESCALATED) {
      throw new Error(`Cannot acknowledge alert in status: ${record.status}`);
    }

    const previousStatus = record.status;
    const now = new Date();
    const ackTimeMs = now.getTime() - record.createdAt.getTime();

    // Update record
    record.status = AckStatus.ACKNOWLEDGED;
    record.sourceType = options.sourceType || AckSourceType.MANUAL;
    record.acknowledgedBy = options.userId;
    record.acknowledgedAt = now;
    record.message = options.message;
    record.updatedAt = now;

    if (options.metadata) {
      record.metadata = { ...record.metadata, ...options.metadata };
    }

    // Set expiration if duration specified
    if (options.durationMs) {
      record.expiresAt = new Date(now.getTime() + options.durationMs);
      // Update pending ack for expiration tracking
      await this.savePendingAck(tenantId, {
        recordId,
        timeoutAt: record.expiresAt.getTime(),
        escalationLevel: record.escalationLevel,
      });
    } else {
      // Remove from pending
      await this.removePendingAck(tenantId, recordId);
    }

    // Add history entry
    record.history.push({
      timestamp: now,
      previousStatus,
      newStatus: AckStatus.ACKNOWLEDGED,
      action: 'acknowledged',
      performedBy: options.userId,
      reason: options.message,
    });

    await this.saveRecord(record);

    // Update metrics
    await this.incrementMetric(tenantId, 'totalAcknowledged');
    await this.appendMetricSample(tenantId, REDIS_KEYS.METRICS_ACK_TIMES, ackTimeMs);
    await this.appendMetricSample(tenantId, REDIS_KEYS.METRICS_TIMEOUT_COUNTS, record.timeoutCount);

    this.eventEmitter.emit('ack.acknowledged', {
      recordId,
      tenantId,
      alertId,
      acknowledgedBy: options.userId,
      ackTimeMs,
      timeoutCount: record.timeoutCount,
      escalationLevel: record.escalationLevel,
    });

    this.logger.debug(`Alert ${alertId} acknowledged by ${options.userId}`);
    return record;
  }

  /**
   * Acknowledge by record ID
   */
  async acknowledgeById(
    tenantId: string,
    recordId: string,
    options: AckRequestOptions,
  ): Promise<AcknowledgmentRecord> {
    const record = await this.loadRecord(tenantId, recordId);
    if (!record) {
      throw new Error(`Acknowledgment record not found: ${recordId}`);
    }
    return this.acknowledge(tenantId, record.alertId, options);
  }

  /**
   * Resolve an acknowledgment record
   */
  async resolve(
    tenantId: string,
    alertId: string,
    userId?: string,
    reason?: string,
  ): Promise<AcknowledgmentRecord> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = await this.loadRecord(tenantId, recordId);
    if (!record) {
      throw new Error(`Acknowledgment record not found: ${recordId}`);
    }

    const previousStatus = record.status;
    const now = new Date();

    record.status = AckStatus.RESOLVED;
    record.updatedAt = now;

    record.history.push({
      timestamp: now,
      previousStatus,
      newStatus: AckStatus.RESOLVED,
      action: 'resolved',
      performedBy: userId,
      reason,
    });

    // Remove from pending
    await this.removePendingAck(tenantId, recordId);
    await this.saveRecord(record);

    await this.incrementMetric(tenantId, 'totalResolved');

    this.eventEmitter.emit('ack.resolved', {
      recordId,
      tenantId,
      alertId,
      resolvedBy: userId,
      reason,
    });

    this.logger.debug(`Alert ${alertId} acknowledgment resolved`);
    return record;
  }

  /**
   * Get acknowledgment record by alert ID
   */
  async getByAlertId(tenantId: string, alertId: string): Promise<AcknowledgmentRecord | undefined> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) return undefined;
    const record = await this.loadRecord(tenantId, recordId);
    return record ?? undefined;
  }

  /**
   * Get acknowledgment record by ID
   */
  async getById(tenantId: string, recordId: string): Promise<AcknowledgmentRecord | undefined> {
    const record = await this.loadRecord(tenantId, recordId);
    return record ?? undefined;
  }

  /**
   * Get all pending acknowledgments
   */
  async getPendingAcks(tenantId: string): Promise<AcknowledgmentRecord[]> {
    const pendingAcks = await this.loadAllPendingAcks(tenantId);
    const records: AcknowledgmentRecord[] = [];

    for (const pending of pendingAcks) {
      const record = await this.loadRecord(tenantId, pending.recordId);
      if (record && (record.status === AckStatus.PENDING || record.status === AckStatus.ESCALATED)) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Get acknowledgments by status
   * Note: This scans all ack records. For large datasets, consider a dedicated index.
   */
  async getByStatus(tenantId: string, status: AckStatus): Promise<AcknowledgmentRecord[]> {
    try {
      const keys = await this.redisService.keys(this.recordPattern(tenantId));
      const records: AcknowledgmentRecord[] = [];

      for (const key of keys) {
        const recordId = this.extractRecordId(tenantId, key);
        const record = await this.loadRecord(tenantId, recordId);
        if (record && record.status === status) {
          records.push(record);
        }
      }

      return records;
    } catch (error) {
      this.logger.error(`Failed to get records by status ${status}`, error);
      return [];
    }
  }

  /**
   * Check for timed out acknowledgments
   */
  private async checkTimeouts(): Promise<void> {
    const now = Date.now();
    let tenantIds: string[];

    try {
      tenantIds = await this.getRegisteredTenants();
    } catch (error) {
      this.logger.error('Failed to load ack tenant registry', error);
      return;
    }

    for (const tenantId of tenantIds) {
      let pendingAcks: PendingAck[];
      try {
        pendingAcks = await this.loadAllPendingAcks(tenantId);
      } catch (error) {
        this.logger.error(`Failed to load pending acks for tenant ${tenantId}`, error);
        continue;
      }

      for (const pending of pendingAcks) {
        if (pending.timeoutAt <= now) {
          const record = await this.loadRecord(tenantId, pending.recordId);
          if (!record) {
            await this.removePendingAck(tenantId, pending.recordId);
            continue;
          }

          await this.handleTimeout(record);
        }
      }
    }
  }

  /**
   * Handle a timeout
   */
  private async handleTimeout(record: AcknowledgmentRecord): Promise<void> {
    const now = new Date();
    const previousStatus = record.status;

    record.timeoutCount++;
    record.updatedAt = now;

    // Check if max timeouts reached
    if (record.timeoutCount >= this.defaultConfig.maxTimeouts) {
      if (this.defaultConfig.autoResolveOnTimeout) {
        // Auto-resolve
        record.status = AckStatus.EXPIRED;
        await this.removePendingAck(record.tenantId, record.id);

        record.history.push({
          timestamp: now,
          previousStatus,
          newStatus: AckStatus.EXPIRED,
          action: 'expired',
          reason: `Max timeouts (${this.defaultConfig.maxTimeouts}) reached`,
        });

        await this.saveRecord(record);
        await this.incrementMetric(record.tenantId, 'totalExpired');

        this.eventEmitter.emit('ack.expired', {
          recordId: record.id,
          tenantId: record.tenantId,
          alertId: record.alertId,
          timeoutCount: record.timeoutCount,
        });

        this.logger.warn(`Ack record ${record.id} expired after ${record.timeoutCount} timeouts`);
      } else if (this.defaultConfig.escalateOnTimeout) {
        // Escalate
        await this.escalate(record);
      }
    } else {
      // Schedule next timeout
      const nextTimeout = this.calculateNextTimeout(record);
      await this.savePendingAck(record.tenantId, {
        recordId: record.id,
        timeoutAt: now.getTime() + nextTimeout,
        escalationLevel: record.escalationLevel,
      });

      record.history.push({
        timestamp: now,
        previousStatus,
        newStatus: previousStatus,
        action: 'timeout',
        reason: `Timeout ${record.timeoutCount} of ${this.defaultConfig.maxTimeouts}`,
      });

      await this.saveRecord(record);

      if (this.defaultConfig.notifyOnTimeout) {
        this.eventEmitter.emit('ack.timeout', {
          recordId: record.id,
          tenantId: record.tenantId,
          alertId: record.alertId,
          timeoutCount: record.timeoutCount,
          maxTimeouts: this.defaultConfig.maxTimeouts,
          nextTimeoutAt: new Date(now.getTime() + nextTimeout),
        });
      }

      this.logger.debug(
        `Ack record ${record.id} timed out (${record.timeoutCount}/${this.defaultConfig.maxTimeouts})`,
      );
    }
  }

  /**
   * Calculate next timeout duration
   */
  private calculateNextTimeout(record: AcknowledgmentRecord): number {
    // Use exponential backoff up to escalation timeout
    const baseTimeout = this.defaultConfig.initialTimeoutMs;
    const maxTimeout = this.defaultConfig.timeoutEscalationMs;
    const calculated = baseTimeout * Math.pow(1.5, record.timeoutCount);
    return Math.min(calculated, maxTimeout);
  }

  /**
   * Escalate an acknowledgment
   */
  private async escalate(record: AcknowledgmentRecord): Promise<void> {
    const now = new Date();
    const previousStatus = record.status;

    record.status = AckStatus.ESCALATED;
    record.escalationLevel++;
    record.updatedAt = now;

    // Schedule escalation timeout
    const escalationTimeout = this.defaultConfig.timeoutEscalationMs;
    await this.savePendingAck(record.tenantId, {
      recordId: record.id,
      timeoutAt: now.getTime() + escalationTimeout,
      escalationLevel: record.escalationLevel,
    });

    record.history.push({
      timestamp: now,
      previousStatus,
      newStatus: AckStatus.ESCALATED,
      action: 'escalated',
      reason: `Escalated to level ${record.escalationLevel}`,
    });

    await this.saveRecord(record);
    await this.incrementMetric(record.tenantId, 'totalEscalated');

    this.eventEmitter.emit('ack.escalated', {
      recordId: record.id,
      tenantId: record.tenantId,
      alertId: record.alertId,
      incidentId: record.incidentId,
      escalationLevel: record.escalationLevel,
      timeoutCount: record.timeoutCount,
    });

    this.logger.warn(
      `Ack record ${record.id} escalated to level ${record.escalationLevel}`,
    );
  }

  /**
   * Manually escalate an acknowledgment
   */
  async manualEscalate(
    tenantId: string,
    alertId: string,
    userId: string,
    reason?: string,
  ): Promise<AcknowledgmentRecord> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = await this.loadRecord(tenantId, recordId);
    if (!record) {
      throw new Error(`Acknowledgment record not found: ${recordId}`);
    }

    const now = new Date();
    const previousStatus = record.status;

    record.status = AckStatus.ESCALATED;
    record.escalationLevel++;
    record.updatedAt = now;

    record.history.push({
      timestamp: now,
      previousStatus,
      newStatus: AckStatus.ESCALATED,
      action: 'manual_escalate',
      performedBy: userId,
      reason: reason || `Manually escalated to level ${record.escalationLevel}`,
    });

    await this.saveRecord(record);
    await this.incrementMetric(tenantId, 'totalEscalated');

    this.eventEmitter.emit('ack.escalated', {
      recordId: record.id,
      tenantId,
      alertId: record.alertId,
      incidentId: record.incidentId,
      escalationLevel: record.escalationLevel,
      manual: true,
      escalatedBy: userId,
    });

    this.logger.log(
      `Ack record ${record.id} manually escalated to level ${record.escalationLevel} by ${userId}`,
    );

    return record;
  }

  /**
   * Unacknowledge (return to pending)
   */
  async unacknowledge(
    tenantId: string,
    alertId: string,
    userId: string,
    reason?: string,
  ): Promise<AcknowledgmentRecord> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = await this.loadRecord(tenantId, recordId);
    if (!record) {
      throw new Error(`Acknowledgment record not found: ${recordId}`);
    }

    if (record.status !== AckStatus.ACKNOWLEDGED) {
      throw new Error(`Cannot unacknowledge alert in status: ${record.status}`);
    }

    const now = new Date();
    const previousStatus = record.status;

    record.status = AckStatus.PENDING;
    record.acknowledgedBy = undefined;
    record.acknowledgedAt = undefined;
    record.expiresAt = undefined;
    record.updatedAt = now;

    // Reset to pending with new timeout
    const timeoutAt = Date.now() + this.defaultConfig.initialTimeoutMs;
    await this.savePendingAck(tenantId, {
      recordId,
      timeoutAt,
      escalationLevel: record.escalationLevel,
    });

    record.history.push({
      timestamp: now,
      previousStatus,
      newStatus: AckStatus.PENDING,
      action: 'unacknowledged',
      performedBy: userId,
      reason,
    });

    await this.saveRecord(record);

    this.eventEmitter.emit('ack.unacknowledged', {
      recordId,
      tenantId,
      alertId,
      unacknowledgedBy: userId,
      reason,
    });

    this.logger.debug(`Alert ${alertId} unacknowledged by ${userId}`);
    return record;
  }

  /**
   * Delete an acknowledgment record
   */
  async deleteRecord(tenantId: string, alertId: string): Promise<boolean> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) return false;

    await this.deleteRecordFromRedis(tenantId, recordId);
    await this.deleteAlertMapping(tenantId, alertId);
    await this.removePendingAck(tenantId, recordId);

    this.logger.debug(`Deleted ack record for alert ${alertId}`);
    return true;
  }

  /**
   * Get statistics
   */
  async getStatistics(tenantId: string): Promise<AckStatistics> {
    try {
      const metricsHash = await this.redisService.hgetall(this.metricsKey(tenantId));
      const totalCreated = parseInt(metricsHash['totalCreated'] || '0', 10);

      // Count records by status by scanning pending set and ack records
      const pendingAcks = await this.loadAllPendingAcks(tenantId);
      let pendingCount = 0;
      let acknowledgedCount = 0;
      let escalatedCount = 0;

      for (const pending of pendingAcks) {
        const record = await this.loadRecord(tenantId, pending.recordId);
        if (record) {
          if (record.status === AckStatus.PENDING) pendingCount++;
          else if (record.status === AckStatus.ESCALATED) escalatedCount++;
          else if (record.status === AckStatus.ACKNOWLEDGED) acknowledgedCount++;
        }
      }

      const expiredCount = parseInt(metricsHash['totalExpired'] || '0', 10);
      const resolvedCount = parseInt(metricsHash['totalResolved'] || '0', 10);

      // Calculate averages from Redis lists
      let averageAckTimeMs = 0;
      let averageTimeoutsBeforeAck = 0;
      try {
        const ackTimesKey = this.metricSampleKey(tenantId, REDIS_KEYS.METRICS_ACK_TIMES);
        const timeoutCountsKey = this.metricSampleKey(
          tenantId,
          REDIS_KEYS.METRICS_TIMEOUT_COUNTS,
        );

        const ackTimes = await this.redisService.lrange(ackTimesKey, 0, -1);
        if (ackTimes.length > 0) {
          const sum = ackTimes.reduce((a, b) => a + parseFloat(b), 0);
          averageAckTimeMs = sum / ackTimes.length;
        }

        const timeoutCounts = await this.redisService.lrange(timeoutCountsKey, 0, -1);
        if (timeoutCounts.length > 0) {
          const sum = timeoutCounts.reduce((a, b) => a + parseFloat(b), 0);
          averageTimeoutsBeforeAck = sum / timeoutCounts.length;
        }
      } catch {
        // Ignore metric calculation errors
      }

      return {
        totalAcks: totalCreated,
        pendingAcks: pendingCount + escalatedCount,
        acknowledgedCount,
        expiredCount,
        escalatedCount,
        resolvedCount,
        averageAckTimeMs,
        averageTimeoutsBeforeAck,
      };
    } catch (error) {
      this.logger.error('Failed to get statistics from Redis', error);
      return {
        totalAcks: 0,
        pendingAcks: 0,
        acknowledgedCount: 0,
        expiredCount: 0,
        escalatedCount: 0,
        resolvedCount: 0,
        averageAckTimeMs: 0,
        averageTimeoutsBeforeAck: 0,
      };
    }
  }

  /**
   * Get history for an alert
   */
  async getHistory(tenantId: string, alertId: string): Promise<AckHistoryEntry[]> {
    const recordId = await this.getRecordIdByAlertId(tenantId, alertId);
    if (!recordId) return [];

    const record = await this.loadRecord(tenantId, recordId);
    return record?.history || [];
  }

  /**
   * Bulk acknowledge multiple alerts
   */
  async bulkAcknowledge(
    tenantId: string,
    alertIds: string[],
    options: AckRequestOptions,
  ): Promise<Map<string, AcknowledgmentRecord | Error>> {
    const MAX_BULK_SIZE = 100;
    if (alertIds.length > MAX_BULK_SIZE) {
      throw new Error(`Bulk acknowledge limited to ${MAX_BULK_SIZE} alerts at a time`);
    }

    const results = new Map<string, AcknowledgmentRecord | Error>();

    for (const alertId of alertIds) {
      try {
        const record = await this.acknowledge(tenantId, alertId, options);
        results.set(alertId, record);
      } catch (error) {
        results.set(alertId, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return results;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `ack_${crypto.randomUUID()}`;
  }

  /**
   * Clean up old records
   * Note: Redis TTL handles most cleanup automatically; this method is for manual cleanup
   * of records that may have stale pending set entries.
   */
  async cleanupOldRecords(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const tenantIds = await this.getRegisteredTenants();
      const cutoff = Date.now() - maxAgeMs;
      let deletedCount = 0;

      for (const tenantId of tenantIds) {
        const keys = await this.redisService.keys(this.recordPattern(tenantId));
        for (const key of keys) {
          const recordId = this.extractRecordId(tenantId, key);
          const record = await this.loadRecord(tenantId, recordId);

          if (
            record &&
            record.updatedAt.getTime() < cutoff &&
            (record.status === AckStatus.RESOLVED || record.status === AckStatus.EXPIRED)
          ) {
            await this.deleteRecordFromRedis(tenantId, recordId);
            await this.deleteAlertMapping(tenantId, record.alertId);
            await this.removePendingAck(tenantId, recordId);
            deletedCount++;
          }
        }
      }

      if (deletedCount > 0) {
        this.logger.log(`Cleaned up ${deletedCount} old ack records`);
      }

      return deletedCount;
    } catch (error) {
      this.logger.error('Failed to cleanup old records', error);
      return 0;
    }
  }
}
