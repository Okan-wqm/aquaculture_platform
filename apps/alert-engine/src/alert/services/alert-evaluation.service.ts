import {
  createBaseEvent,
  toEventIso,
  AlertTriggeredEvent,
  AlertResolvedEvent,
} from '@platform/event-contracts';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  AlertRule,
  AlertCondition,
  AlertOperator,
  AlertSeverity,
} from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';
import { RedisService } from '@aquaculture/backend-common/redis';

/**
 * Sensor reading data structure
 */
export interface SensorReadingData {
  sensorId: string;
  tenantId: string;
  readings: Record<string, number>;
  farmId?: string;
  pondId?: string;
  timestamp: string | Date;
}

/**
 * Alert Evaluation Service
 * Evaluates sensor readings against alert rules
 * Implements cooldown to prevent alert spam
 */

@Injectable()
export class AlertEvaluationService {
  private readonly logger = new Logger(AlertEvaluationService.name);

  // Redis-based rule cache TTL in seconds (shared across all instances)
  private static readonly RULE_CACHE_TTL_S = 30;

  constructor(
    @InjectRepository(AlertRule)
    private readonly ruleRepository: Repository<AlertRule>,
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    @InjectRepository(AlertIncident)
    private readonly incidentRepository: Repository<AlertIncident>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly redisService: RedisService,
    private readonly escalationManager: EscalationManagerService,
  ) {}

  /**
   * Evaluate sensor reading against all applicable rules
   */
  async evaluateSensorReading(reading: SensorReadingData): Promise<void> {
    try {
      // Find applicable rules for this reading
      const rules = await this.findApplicableRules(
        reading.tenantId,
        reading.sensorId,
        reading.farmId,
        reading.pondId,
      );

      this.logger.debug(
        `Found ${rules.length} applicable rules for sensor ${reading.sensorId}`,
      );

      // PE-04: Evaluate all conditions synchronously first (no I/O), then
      // fire all cooldown checks + alert triggers in parallel.
      const triggered = rules
        .map(rule => ({
          rule,
          condition: this.checkConditions(rule.conditions, reading.readings),
        }))
        .filter((r): r is { rule: AlertRule; condition: AlertCondition } => r.condition !== null);

      if (triggered.length > 0) {
        await Promise.all(
          triggered.map(({ rule, condition }) =>
            this.atomicCheckCooldownAndTrigger(rule, reading, condition),
          ),
        );
      } else {
        // No conditions matched -- sensor is back in normal range.
        // Auto-resolve any active incidents for this sensor (INFO/LOW only).
        await this.autoResolveIfNormal(reading);
      }
    } catch (error) {
      this.logger.error(
        `Error evaluating sensor reading: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * Find all active rules that apply to this sensor reading.
   * PE-16: Results are cached in Redis for RULE_CACHE_TTL_S per unique
   * (tenantId, sensorId, farmId, pondId) combination to avoid a DB query
   * on every high-frequency sensor reading event.
   *
   * Redis-based cache ensures all replicas share the same rule state,
   * eliminating the 30s propagation delay of per-instance in-memory caches.
   */
  private async findApplicableRules(
    tenantId: string,
    sensorId: string,
    farmId?: string,
    pondId?: string,
  ): Promise<AlertRule[]> {
    const cacheKey = `alert:rules:${tenantId}:${sensorId}:${farmId ?? ''}:${pondId ?? ''}`;

    // Try Redis cache first
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as AlertRule[];
      }
    } catch (err) {
      this.logger.debug(`Redis cache read failed for rules, falling back to DB: ${(err as Error).message}`);
    }

    const query = this.ruleRepository
      .createQueryBuilder('rule')
      .where('rule.tenantId = :tenantId', { tenantId })
      .andWhere('rule.isActive = true')
      .andWhere(
        '(rule.sensorId IS NULL OR rule.sensorId = :sensorId)',
        { sensorId },
      );

    // Always apply farm/pond filters to prevent cross-scope rule leakage.
    // When farmId is undefined, only return rules that are not scoped to any farm.
    if (farmId) {
      query.andWhere(
        '(rule.farmId IS NULL OR rule.farmId = :farmId)',
        { farmId },
      );
    } else {
      query.andWhere('rule.farmId IS NULL');
    }

    if (pondId) {
      query.andWhere(
        '(rule.pondId IS NULL OR rule.pondId = :pondId)',
        { pondId },
      );
    } else {
      query.andWhere('rule.pondId IS NULL');
    }

    const rules = await query.getMany();

    // Populate Redis cache (best-effort, non-blocking)
    try {
      await this.redisService.set(
        cacheKey,
        JSON.stringify(rules),
        AlertEvaluationService.RULE_CACHE_TTL_S,
      );
    } catch (err) {
      this.logger.debug(`Redis cache write failed for rules: ${(err as Error).message}`);
    }

    return rules;
  }

  /**
   * Invalidate all cached rules for a tenant.
   * Must be called after rule create/update/delete operations.
   */
  async invalidateRuleCache(tenantId: string): Promise<void> {
    try {
      await this.redisService.deletePattern(`alert:rules:${tenantId}:*`);
      this.logger.debug(`Invalidated rule cache for tenant ${tenantId}`);
    } catch (err) {
      this.logger.warn(`Failed to invalidate rule cache for tenant ${tenantId}: ${(err as Error).message}`);
    }
  }

  /**
   * Severity ranking for comparison (higher = more severe)
   */
  private static readonly SEVERITY_RANK: Record<string, number> = {
    [AlertSeverity.INFO]: 0,
    [AlertSeverity.LOW]: 1,
    [AlertSeverity.WARNING]: 2,
    [AlertSeverity.MEDIUM]: 3,
    [AlertSeverity.HIGH]: 4,
    [AlertSeverity.CRITICAL]: 5,
  };

  /**
   * Check all conditions and return the most severe match
   */
  private checkConditions(
    conditions: AlertCondition[],
    readings: Record<string, number>,
  ): AlertCondition | null {
    let mostSevere: AlertCondition | null = null;

    for (const condition of conditions) {
      const value = readings[condition.parameter];

      // Skip if value is null, undefined, or not a valid number
      // This prevents false negatives from null comparisons (null > threshold = false)
      if (value === undefined || value === null || typeof value !== 'number' || isNaN(value)) {
        continue;
      }

      let triggered = false;

      switch (condition.operator) {
        case AlertOperator.GT:
          triggered = value > condition.threshold;
          break;
        case AlertOperator.GTE:
          triggered = value >= condition.threshold;
          break;
        case AlertOperator.LT:
          triggered = value < condition.threshold;
          break;
        case AlertOperator.LTE:
          triggered = value <= condition.threshold;
          break;
        case AlertOperator.EQ:
          triggered = value === condition.threshold;
          break;
      }

      if (triggered) {
        if (!mostSevere) {
          mostSevere = condition;
        } else {
          const currentRank = AlertEvaluationService.SEVERITY_RANK[condition.severity] ?? 0;
          const bestRank = AlertEvaluationService.SEVERITY_RANK[mostSevere.severity] ?? 0;
          if (currentRank > bestRank) {
            mostSevere = condition;
          }
        }
      }
    }

    return mostSevere;
  }

  /**
   * PE-01: Atomic cooldown check and alert trigger using Redis SET NX EX.
   * Replaces the previous SERIALIZABLE DB transaction + FOR UPDATE lock pattern
   * which serialised all concurrent rule evaluations for the same rule.
   *
   * Redis SET NX is atomic by design: only the first caller for a given
   * (tenantId, ruleId) window will succeed; all others are rejected until the
   * TTL expires (= cooldownMinutes).  This removes the DB round-trip from the
   * hot path entirely for the cooldown check.
   */
  private async atomicCheckCooldownAndTrigger(
    rule: AlertRule,
    reading: SensorReadingData,
    condition: AlertCondition,
  ): Promise<void> {
    // Attempt to acquire the cooldown lock atomically.
    // SET NX succeeds (returns 'OK') only if the key does not exist.
    if (rule.cooldownMinutes > 0) {
      const cooldownKey = `cooldown:${reading.tenantId}:${rule.id}`;
      const wasSet = await this.redisService.setNx(
        cooldownKey,
        '1',
        rule.cooldownMinutes * 60,
      );
      if (!wasSet) {
        this.logger.debug(`Alert for rule ${rule.id} is in cooldown period`);
        return;
      }
    }

    // Cooldown cleared – build the alert history record.
    const currentValue = reading.readings[condition.parameter];
    const message = `Alert: ${rule.name} - ${condition.parameter} is ${this.formatOperator(condition.operator)} ${condition.threshold}. Current value: ${currentValue}`;

    const history = this.historyRepository.create({
      ruleId: rule.id,
      ruleName: rule.name,
      tenantId: reading.tenantId,
      farmId: reading.farmId,
      pondId: reading.pondId,
      sensorId: reading.sensorId,
      severity: condition.severity,
      message,
      triggeringData: {
        sensorId: reading.sensorId,
        readings: reading.readings,
        timestamp: reading.timestamp,
        condition: {
          parameter: condition.parameter,
          operator: condition.operator,
          threshold: condition.threshold,
          actualValue: currentValue,
        },
      },
      triggeredAt: reading.timestamp,
    });

    // LIFE-SAFETY (ALERT-CRITICAL-001): the history row (which represents
    // "an alert fired"), the incident it feeds, and the AlertTriggered event
    // that notifies the operator MUST commit atomically. The AlertTriggered
    // event is enqueued into the transactional outbox on the SAME
    // EntityManager as the state writes — either all three commit or none.
    // A swallowed publish after commit (the previous behaviour) left an
    // incident persisted but the operator never notified of, e.g., a
    // dissolved-oxygen crash. No try/catch wraps the enqueue: a failed
    // enqueue MUST propagate so the transaction rolls back.
    const newIncident = await this.dataSource.transaction(async (manager) => {
      const savedHistory = await manager.save(AlertHistory, history);

      // Create or update an AlertIncident to feed the escalation pipeline.
      const created = await this.ensureIncident(
        manager,
        rule,
        reading,
        condition,
        savedHistory,
        message,
      );

      const event = this.buildAlertTriggeredEvent(
        rule,
        reading,
        condition,
        savedHistory.id,
        message,
      );
      await this.outboxPublisher.enqueue(event, manager);

      return created;
    });

    // Start the escalation pipeline only for freshly-created incidents, and
    // only AFTER the trigger has durably committed. Escalation manages its
    // own Redis-backed timers/state outside this transaction, so it must run
    // post-commit — never inside it (a rollback would orphan the timers).
    if (newIncident) {
      this.escalationManager
        .startEscalation(newIncident, condition.severity, rule.id, reading.farmId)
        .catch((err: Error) => {
          this.logger.error(
            `Failed to start escalation for incident ${newIncident.id}: ${err.message}`,
          );
        });
    }
  }

  /**
   * Ensure an AlertIncident exists for the triggered rule.
   *
   * If an active (non-resolved/closed/suppressed) incident already exists for
   * this ruleId + tenantId combination, we bump its occurrence count instead of
   * creating a duplicate.  Otherwise we create a NEW incident and kick off the
   * escalation pipeline.
   */
  private async ensureIncident(
    manager: EntityManager,
    rule: AlertRule,
    reading: SensorReadingData,
    condition: AlertCondition,
    savedHistory: AlertHistory,
    message: string,
  ): Promise<AlertIncident | null> {
    // Look for an existing open incident for this rule + tenant.
    const activeStatuses: IncidentStatus[] = [
      IncidentStatus.NEW,
      IncidentStatus.ACKNOWLEDGED,
      IncidentStatus.INVESTIGATING,
    ];

    const existingIncident = await manager.findOne(AlertIncident, {
      where: {
        ruleId: rule.id,
        tenantId: reading.tenantId,
        status: In(activeStatuses),
      },
      order: { createdAt: 'DESC' },
    });

    if (existingIncident) {
      // Bump occurrence count on the existing incident.
      existingIncident.recordOccurrence();
      await manager.save(AlertIncident, existingIncident);
      this.logger.debug(
        `Updated existing incident ${existingIncident.id} for rule ${rule.id} ` +
        `(occurrences: ${existingIncident.occurrenceCount})`,
      );
      // No new incident → no fresh escalation pipeline to start post-commit.
      return null;
    }

    // No active incident – create a new one.
    const incident = this.incidentRepository.create({
      tenantId: reading.tenantId,
      ruleId: rule.id,
      title: `${rule.name}: ${condition.parameter} ${this.formatOperator(condition.operator)} ${condition.threshold}`,
      description: message,
      severity: condition.severity,
      status: IncidentStatus.NEW,
      riskScore: 0,
      triggerData: {
        historyId: savedHistory.id,
        sensorId: reading.sensorId,
        readings: reading.readings,
        timestamp: reading.timestamp,
        condition: {
          parameter: condition.parameter,
          operator: condition.operator,
          threshold: condition.threshold,
          actualValue: reading.readings[condition.parameter],
        },
      },
      farmId: reading.farmId,
      pondId: reading.pondId,
      sensorId: reading.sensorId,
      escalationLevel: 0,
      timeline: [],
      relatedIncidentIds: [],
      occurrenceCount: 1,
      lastOccurredAt: reading.timestamp,
    });

    // Seed the timeline with a CREATED event.
    incident.addTimelineEvent({
      type: TimelineEventType.CREATED,
      description: message,
    });

    const savedIncident = await manager.save(AlertIncident, incident);

    this.logger.log(
      `Created incident ${savedIncident.id} for rule ${rule.id} (severity: ${condition.severity})`,
    );

    // The escalation pipeline is started by the caller AFTER commit (it
    // manages Redis timers/state outside this DB transaction).
    return savedIncident;
  }

  /**
   * Build the AlertTriggered domain event (v2 — flat triggerXxx fields).
   *
   * Pure builder: performs NO I/O. The caller enqueues the returned event on
   * the transaction manager so it commits atomically with the history +
   * incident writes (ALERT-CRITICAL-001).
   *
   * ARCH-C01: Emits flat fields instead of a nested `triggeringData` object.
   */
  private buildAlertTriggeredEvent(
    rule: AlertRule,
    reading: SensorReadingData,
    condition: AlertCondition,
    alertId: string,
    message: string,
  ): AlertTriggeredEvent {
    return {
      ...createBaseEvent<AlertTriggeredEvent>('AlertTriggered', reading.tenantId, {
        aggregateId: alertId,
        aggregateType: 'Alert',
        version: 2,
      }),
      alertId,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: condition.severity,
      message,
      channels: rule.notificationChannels || [],
      recipients: rule.recipients || [],
      triggerSensorId: reading.sensorId,
      triggerFarmId: reading.farmId,
      triggerPondId: reading.pondId,
      triggerParameter: condition.parameter,
      triggerValue: reading.readings[condition.parameter],
      triggerThreshold: condition.threshold,
    };
  }

  /**
   * Build the AlertResolved domain event for an auto-resolved incident.
   *
   * Pure builder: performs NO I/O. The caller enqueues the returned event on
   * the transaction manager so it commits atomically with the incident
   * resolution write (ALERT-CRITICAL-001).
   */
  private buildAlertResolvedEvent(
    tenantId: string,
    incidentId: string,
    resolvedAt: Date,
  ): AlertResolvedEvent {
    return {
      ...createBaseEvent<AlertResolvedEvent>('AlertResolved', tenantId, {
        aggregateId: incidentId,
        aggregateType: 'AlertIncident',
      }),
      alertId: incidentId,
      resolvedBy: 'SYSTEM_AUTO_RESOLVE',
      resolvedAt: toEventIso(resolvedAt),
      resolution: 'Sensor readings returned to normal range',
      autoResolved: true,
    };
  }

  /**
   * Format operator for human-readable message
   */
  private formatOperator(operator: AlertOperator): string {
    switch (operator) {
      case AlertOperator.GT:
        return 'greater than';
      case AlertOperator.GTE:
        return 'greater than or equal to';
      case AlertOperator.LT:
        return 'less than';
      case AlertOperator.LTE:
        return 'less than or equal to';
      case AlertOperator.EQ:
        return 'equal to';
      default:
        return operator;
    }
  }

  /**
   * Severities eligible for automatic resolution when the sensor value
   * returns to normal range.  Only low-severity incidents are auto-resolved;
   * higher severities (WARNING+) require explicit human acknowledgement.
   */
  private static readonly AUTO_RESOLVE_SEVERITIES: Set<string> = new Set([
    AlertSeverity.INFO,
    AlertSeverity.LOW,
  ]);

  /**
   * Check whether an incident's severity allows automatic resolution.
   */
  private isAutoResolvable(severity: AlertSeverity | string): boolean {
    return AlertEvaluationService.AUTO_RESOLVE_SEVERITIES.has(severity);
  }

  /**
   * When no alert conditions matched for a sensor reading, check for any
   * active incidents tied to this sensor + tenant and auto-resolve those
   * whose severity is INFO or LOW.
   */
  private async autoResolveIfNormal(reading: SensorReadingData): Promise<void> {
    try {
      const activeStatuses: IncidentStatus[] = [
        IncidentStatus.NEW,
        IncidentStatus.ACKNOWLEDGED,
        IncidentStatus.INVESTIGATING,
      ];

      const activeIncidents = await this.incidentRepository.find({
        where: {
          sensorId: reading.sensorId,
          tenantId: reading.tenantId,
          status: In(activeStatuses),
        },
      });

      for (const incident of activeIncidents) {
        if (!this.isAutoResolvable(incident.severity)) {
          continue;
        }

        const resolvedAt = new Date();
        incident.status = IncidentStatus.RESOLVED;
        incident.resolvedAt = resolvedAt;
        incident.resolvedBy = 'SYSTEM_AUTO_RESOLVE';
        incident.resolutionNotes =
          'Automatically resolved: sensor readings returned to normal range.';

        incident.addTimelineEvent({
          type: TimelineEventType.RESOLVED,
          description:
            'Auto-resolved: all sensor readings within normal thresholds.',
        });

        // LIFE-SAFETY (ALERT-CRITICAL-001): the incident-resolution state
        // write and the AlertResolved event commit atomically via the
        // transactional outbox. A swallowed publish after commit (the
        // previous behaviour) could leave downstream services (notification,
        // audit) believing an incident was still open. No try/catch wraps the
        // enqueue — a failed enqueue rolls back the resolution. Each incident
        // gets its own transaction so one failure does not unwind siblings.
        const event = this.buildAlertResolvedEvent(
          reading.tenantId,
          incident.id,
          resolvedAt,
        );
        await this.dataSource.transaction(async (manager) => {
          await manager.save(AlertIncident, incident);
          await this.outboxPublisher.enqueue(event, manager);
        });

        this.logger.log(
          `Auto-resolved incident ${incident.id} (severity: ${incident.severity}) ` +
          `for sensor ${reading.sensorId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to auto-resolve incidents for sensor ${reading.sensorId}: ` +
        `${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
