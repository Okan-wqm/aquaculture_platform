/**
 * Acknowledgment Tracker Service
 *
 * Tracks and manages acknowledgment states for alerts and incidents.
 * Handles ack timeouts, ack escalation, and ack-related workflows.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

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

@Injectable()
export class AcknowledgmentTrackerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AcknowledgmentTrackerService.name);

  private readonly records = new Map<string, AcknowledgmentRecord>();
  private readonly alertToRecordMap = new Map<string, string>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private timeoutChecker: NodeJS.Timeout | null = null;

  private defaultConfig: AckTimeoutConfig = {
    initialTimeoutMs: 5 * 60 * 1000, // 5 minutes
    maxTimeouts: 3,
    timeoutEscalationMs: 10 * 60 * 1000, // 10 minutes
    autoResolveOnTimeout: false,
    notifyOnTimeout: true,
    escalateOnTimeout: true,
  };

  // Metrics
  private metrics = {
    totalCreated: 0,
    totalAcknowledged: 0,
    totalExpired: 0,
    totalEscalated: 0,
    totalResolved: 0,
    ackTimes: [] as number[],
    timeoutCounts: [] as number[],
  };

  constructor(private readonly eventEmitter: EventEmitter2) {}

  onModuleInit(): void {
    // Start timeout checker
    this.timeoutChecker = setInterval(
      () => this.checkTimeouts(),
      10000, // Check every 10 seconds
    );

    this.logger.log('AcknowledgmentTrackerService initialized');
  }

  onModuleDestroy(): void {
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = null;
    }
  }

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

  /**
   * Create a new acknowledgment tracking record
   */
  createRecord(
    alertId: string,
    incidentId?: string,
    config?: Partial<AckTimeoutConfig>,
  ): AcknowledgmentRecord {
    const id = this.generateId();
    const effectiveConfig = { ...this.defaultConfig, ...config };

    const record: AcknowledgmentRecord = {
      id,
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

    this.records.set(id, record);
    this.alertToRecordMap.set(alertId, id);
    this.pendingAcks.set(id, {
      recordId: id,
      timeoutAt,
      escalationLevel: 0,
    });

    this.metrics.totalCreated++;

    this.eventEmitter.emit('ack.created', {
      recordId: id,
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
  acknowledge(alertId: string, options: AckRequestOptions): AcknowledgmentRecord {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = this.records.get(recordId);
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
      this.pendingAcks.set(recordId, {
        recordId,
        timeoutAt: record.expiresAt.getTime(),
        escalationLevel: record.escalationLevel,
      });
    } else {
      // Remove from pending
      this.pendingAcks.delete(recordId);
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

    // Update metrics
    this.metrics.totalAcknowledged++;
    this.metrics.ackTimes.push(ackTimeMs);
    this.metrics.timeoutCounts.push(record.timeoutCount);

    this.eventEmitter.emit('ack.acknowledged', {
      recordId,
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
  acknowledgeById(recordId: string, options: AckRequestOptions): AcknowledgmentRecord {
    const record = this.records.get(recordId);
    if (!record) {
      throw new Error(`Acknowledgment record not found: ${recordId}`);
    }
    return this.acknowledge(record.alertId, options);
  }

  /**
   * Resolve an acknowledgment record
   */
  resolve(alertId: string, userId?: string, reason?: string): AcknowledgmentRecord {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = this.records.get(recordId);
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
    this.pendingAcks.delete(recordId);

    this.metrics.totalResolved++;

    this.eventEmitter.emit('ack.resolved', {
      recordId,
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
  getByAlertId(alertId: string): AcknowledgmentRecord | undefined {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) return undefined;
    return this.records.get(recordId);
  }

  /**
   * Get acknowledgment record by ID
   */
  getById(recordId: string): AcknowledgmentRecord | undefined {
    return this.records.get(recordId);
  }

  /**
   * Get all pending acknowledgments
   */
  getPendingAcks(): AcknowledgmentRecord[] {
    return Array.from(this.records.values()).filter(
      r => r.status === AckStatus.PENDING || r.status === AckStatus.ESCALATED,
    );
  }

  /**
   * Get acknowledgments by status
   */
  getByStatus(status: AckStatus): AcknowledgmentRecord[] {
    return Array.from(this.records.values()).filter(r => r.status === status);
  }

  /**
   * Check for timed out acknowledgments
   */
  private checkTimeouts(): void {
    const now = Date.now();

    for (const [recordId, pending] of this.pendingAcks) {
      if (pending.timeoutAt <= now) {
        const record = this.records.get(recordId);
        if (!record) {
          this.pendingAcks.delete(recordId);
          continue;
        }

        this.handleTimeout(record);
      }
    }
  }

  /**
   * Handle a timeout
   */
  private handleTimeout(record: AcknowledgmentRecord): void {
    const now = new Date();
    const previousStatus = record.status;

    record.timeoutCount++;
    record.updatedAt = now;

    // Check if max timeouts reached
    if (record.timeoutCount >= this.defaultConfig.maxTimeouts) {
      if (this.defaultConfig.autoResolveOnTimeout) {
        // Auto-resolve
        record.status = AckStatus.EXPIRED;
        this.pendingAcks.delete(record.id);
        this.metrics.totalExpired++;

        record.history.push({
          timestamp: now,
          previousStatus,
          newStatus: AckStatus.EXPIRED,
          action: 'expired',
          reason: `Max timeouts (${this.defaultConfig.maxTimeouts}) reached`,
        });

        this.eventEmitter.emit('ack.expired', {
          recordId: record.id,
          alertId: record.alertId,
          timeoutCount: record.timeoutCount,
        });

        this.logger.warn(`Ack record ${record.id} expired after ${record.timeoutCount} timeouts`);
      } else if (this.defaultConfig.escalateOnTimeout) {
        // Escalate
        this.escalate(record);
      }
    } else {
      // Schedule next timeout
      const nextTimeout = this.calculateNextTimeout(record);
      this.pendingAcks.set(record.id, {
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

      if (this.defaultConfig.notifyOnTimeout) {
        this.eventEmitter.emit('ack.timeout', {
          recordId: record.id,
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
  private escalate(record: AcknowledgmentRecord): void {
    const now = new Date();
    const previousStatus = record.status;

    record.status = AckStatus.ESCALATED;
    record.escalationLevel++;
    record.updatedAt = now;

    // Schedule escalation timeout
    const escalationTimeout = this.defaultConfig.timeoutEscalationMs;
    this.pendingAcks.set(record.id, {
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

    this.metrics.totalEscalated++;

    this.eventEmitter.emit('ack.escalated', {
      recordId: record.id,
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
  manualEscalate(
    alertId: string,
    userId: string,
    reason?: string,
  ): AcknowledgmentRecord {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = this.records.get(recordId);
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

    this.metrics.totalEscalated++;

    this.eventEmitter.emit('ack.escalated', {
      recordId: record.id,
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
  unacknowledge(alertId: string, userId: string, reason?: string): AcknowledgmentRecord {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) {
      throw new Error(`No acknowledgment record found for alert: ${alertId}`);
    }

    const record = this.records.get(recordId);
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
    this.pendingAcks.set(recordId, {
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

    this.eventEmitter.emit('ack.unacknowledged', {
      recordId,
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
  deleteRecord(alertId: string): boolean {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) return false;

    this.records.delete(recordId);
    this.alertToRecordMap.delete(alertId);
    this.pendingAcks.delete(recordId);

    this.logger.debug(`Deleted ack record for alert ${alertId}`);
    return true;
  }

  /**
   * Get statistics
   */
  getStatistics(): AckStatistics {
    const records = Array.from(this.records.values());

    const statusCounts = records.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      {} as Record<AckStatus, number>,
    );

    const averageAckTimeMs =
      this.metrics.ackTimes.length > 0
        ? this.metrics.ackTimes.reduce((a, b) => a + b, 0) / this.metrics.ackTimes.length
        : 0;

    const averageTimeoutsBeforeAck =
      this.metrics.timeoutCounts.length > 0
        ? this.metrics.timeoutCounts.reduce((a, b) => a + b, 0) /
          this.metrics.timeoutCounts.length
        : 0;

    return {
      totalAcks: this.metrics.totalCreated,
      pendingAcks: (statusCounts[AckStatus.PENDING] || 0) + (statusCounts[AckStatus.ESCALATED] || 0),
      acknowledgedCount: statusCounts[AckStatus.ACKNOWLEDGED] || 0,
      expiredCount: statusCounts[AckStatus.EXPIRED] || 0,
      escalatedCount: statusCounts[AckStatus.ESCALATED] || 0,
      resolvedCount: statusCounts[AckStatus.RESOLVED] || 0,
      averageAckTimeMs,
      averageTimeoutsBeforeAck,
    };
  }

  /**
   * Get history for an alert
   */
  getHistory(alertId: string): AckHistoryEntry[] {
    const recordId = this.alertToRecordMap.get(alertId);
    if (!recordId) return [];

    const record = this.records.get(recordId);
    return record?.history || [];
  }

  /**
   * Bulk acknowledge multiple alerts
   */
  bulkAcknowledge(alertIds: string[], options: AckRequestOptions): Map<string, AcknowledgmentRecord | Error> {
    const results = new Map<string, AcknowledgmentRecord | Error>();

    for (const alertId of alertIds) {
      try {
        const record = this.acknowledge(alertId, options);
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
    return `ack_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up old records
   */
  cleanupOldRecords(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let deletedCount = 0;

    for (const [id, record] of this.records) {
      if (
        record.updatedAt.getTime() < cutoff &&
        (record.status === AckStatus.RESOLVED || record.status === AckStatus.EXPIRED)
      ) {
        this.records.delete(id);
        this.alertToRecordMap.delete(record.alertId);
        this.pendingAcks.delete(id);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${deletedCount} old ack records`);
    }

    return deletedCount;
  }
}
