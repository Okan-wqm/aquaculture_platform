import * as crypto from 'crypto';
import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
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
import { IEventBus } from '@platform/event-bus';
import { RedisService } from '@platform/backend-common';

/**
 * Sensor reading data structure
 */
export interface SensorReadingData {
  sensorId: string;
  tenantId: string;
  readings: Record<string, number>;
  farmId?: string;
  pondId?: string;
  timestamp: Date;
}

/**
 * Alert Evaluation Service
 * Evaluates sensor readings against alert rules
 * Implements cooldown to prevent alert spam
 */
/** Short-lived cache entry for applicable rules */
interface CachedRuleSet {
  rules: AlertRule[];
  expiresAt: number;
}

@Injectable()
export class AlertEvaluationService {
  private readonly logger = new Logger(AlertEvaluationService.name);

  // PE-16: Short-lived in-process cache for applicable rules so that rapid
  // sensor readings for the same sensor don't hit the DB every time.
  private readonly ruleCache = new Map<string, CachedRuleSet>();
  private static readonly RULE_CACHE_TTL_MS = 30_000; // 30 seconds

  constructor(
    @InjectRepository(AlertRule)
    private readonly ruleRepository: Repository<AlertRule>,
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    @InjectRepository(AlertIncident)
    private readonly incidentRepository: Repository<AlertIncident>,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
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

      await Promise.all(
        triggered.map(({ rule, condition }) =>
          this.atomicCheckCooldownAndTrigger(rule, reading, condition),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Error evaluating sensor reading: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * Find all active rules that apply to this sensor reading.
   * PE-16: Results are cached for RULE_CACHE_TTL_MS per unique
   * (tenantId, sensorId, farmId, pondId) combination to avoid a DB query
   * on every high-frequency sensor reading event.
   */
  private async findApplicableRules(
    tenantId: string,
    sensorId: string,
    farmId?: string,
    pondId?: string,
  ): Promise<AlertRule[]> {
    const cacheKey = `${tenantId}:${sensorId}:${farmId ?? ''}:${pondId ?? ''}`;
    const cached = this.ruleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.rules;
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

    this.ruleCache.set(cacheKey, {
      rules,
      expiresAt: Date.now() + AlertEvaluationService.RULE_CACHE_TTL_MS,
    });

    return rules;
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
    try {
      // Attempt to acquire the cooldown lock atomically.
      // SET NX succeeds (returns 'OK') only if the key does not exist.
      if (rule.cooldownMinutes > 0) {
        const cooldownKey = `cooldown:${reading.tenantId}:${rule.id}`;
        const existing = await this.redisService.get(cooldownKey);
        if (existing !== null) {
          this.logger.debug(`Alert for rule ${rule.id} is in cooldown period`);
          return;
        }
        await this.redisService.set(cooldownKey, '1', rule.cooldownMinutes * 60);
      }

      // Cooldown cleared – save the alert history record.
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

      const savedHistory = await this.historyRepository.save(history);

      // Create or update an AlertIncident to feed the escalation pipeline.
      await this.ensureIncident(rule, reading, condition, savedHistory, message);

      // Publish event after the DB write succeeds.
      await this.publishAlertEvent(rule, reading, condition, savedHistory.id, message);
    } catch (error) {
      // Log but don't throw – we don't want to fail other rule evaluations.
      this.logger.error(
        `Failed to trigger alert for rule ${rule.id}: ${(error as Error).message}`,
      );
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
    rule: AlertRule,
    reading: SensorReadingData,
    condition: AlertCondition,
    savedHistory: AlertHistory,
    message: string,
  ): Promise<void> {
    try {
      // Look for an existing open incident for this rule + tenant.
      const activeStatuses: IncidentStatus[] = [
        IncidentStatus.NEW,
        IncidentStatus.ACKNOWLEDGED,
        IncidentStatus.INVESTIGATING,
      ];

      const existingIncident = await this.incidentRepository.findOne({
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
        await this.incidentRepository.save(existingIncident);
        this.logger.debug(
          `Updated existing incident ${existingIncident.id} for rule ${rule.id} ` +
          `(occurrences: ${existingIncident.occurrenceCount})`,
        );
        return;
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

      const savedIncident = await this.incidentRepository.save(incident);

      this.logger.log(
        `Created incident ${savedIncident.id} for rule ${rule.id} (severity: ${condition.severity})`,
      );

      // Start the escalation pipeline (non-blocking for the alert flow).
      this.escalationManager
        .startEscalation(savedIncident, condition.severity, rule.id, reading.farmId)
        .catch((err: Error) => {
          this.logger.error(
            `Failed to start escalation for incident ${savedIncident.id}: ${err.message}`,
          );
        });
    } catch (error) {
      // Incident/escalation failure must not break the existing AlertHistory flow.
      this.logger.error(
        `Failed to ensure incident for rule ${rule.id}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * Publish AlertTriggered event
   */
  private async publishAlertEvent(
    rule: AlertRule,
    reading: SensorReadingData,
    condition: AlertCondition,
    alertId: string,
    message: string,
  ): Promise<void> {
    try {
      await this.eventBus.publish({
        eventId: crypto.randomUUID(),
        eventType: 'AlertTriggered',
        timestamp: new Date(),
        tenantId: reading.tenantId,
        alertId,
        ruleId: rule.id,
        ruleName: rule.name,
        severity: condition.severity,
        message,
        channels: rule.notificationChannels || [],
        recipients: rule.recipients || [],
        triggeringData: {
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
        version: 1,
      });
    } catch (error) {
      this.logger.error(
        `Failed to publish alert event: ${(error as Error).message}`,
      );
    }
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
}
