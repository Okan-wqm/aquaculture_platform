import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import {
  AlertRule,
  AlertCondition,
  AlertOperator,
  AlertSeverity,
} from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { IEventBus } from '@platform/event-bus';

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
@Injectable()
export class AlertEvaluationService {
  private readonly logger = new Logger(AlertEvaluationService.name);

  constructor(
    @InjectRepository(AlertRule)
    private readonly ruleRepository: Repository<AlertRule>,
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
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

      for (const rule of rules) {
        const triggeredCondition = this.checkConditions(
          rule.conditions,
          reading.readings,
        );

        if (triggeredCondition) {
          const canTrigger = await this.checkCooldown(
            rule.id,
            rule.cooldownMinutes,
          );

          if (canTrigger) {
            await this.triggerAlert(rule, reading, triggeredCondition);
          } else {
            this.logger.debug(
              `Alert for rule ${rule.id} is in cooldown period`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Error evaluating sensor reading: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * Find all active rules that apply to this sensor reading
   */
  private async findApplicableRules(
    tenantId: string,
    sensorId: string,
    farmId?: string,
    pondId?: string,
  ): Promise<AlertRule[]> {
    const query = this.ruleRepository
      .createQueryBuilder('rule')
      .where('rule.tenantId = :tenantId', { tenantId })
      .andWhere('rule.isActive = true')
      .andWhere(
        '(rule.sensorId IS NULL OR rule.sensorId = :sensorId)',
        { sensorId },
      );

    if (farmId) {
      query.andWhere(
        '(rule.farmId IS NULL OR rule.farmId = :farmId)',
        { farmId },
      );
    }

    if (pondId) {
      query.andWhere(
        '(rule.pondId IS NULL OR rule.pondId = :pondId)',
        { pondId },
      );
    }

    return await query.getMany();
  }

  /**
   * Check if any condition is met
   */
  private checkConditions(
    conditions: AlertCondition[],
    readings: Record<string, number>,
  ): AlertCondition | null {
    for (const condition of conditions) {
      const value = readings[condition.parameter];

      if (value === undefined) {
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
        return condition;
      }
    }

    return null;
  }

  /**
   * Check if cooldown period has passed
   */
  private async checkCooldown(
    ruleId: string,
    cooldownMinutes: number,
  ): Promise<boolean> {
    if (cooldownMinutes === 0) {
      return true;
    }

    const cooldownDate = new Date();
    cooldownDate.setMinutes(cooldownDate.getMinutes() - cooldownMinutes);

    const recentAlert = await this.historyRepository.findOne({
      where: {
        ruleId,
        triggeredAt: MoreThan(cooldownDate),
      },
      order: { triggeredAt: 'DESC' },
    });

    return !recentAlert;
  }

  /**
   * Trigger an alert and publish event
   */
  private async triggerAlert(
    rule: AlertRule,
    reading: SensorReadingData,
    condition: AlertCondition,
  ): Promise<void> {
    const currentValue = reading.readings[condition.parameter];
    const message = `Alert: ${rule.name} - ${condition.parameter} is ${this.formatOperator(condition.operator)} ${condition.threshold}. Current value: ${currentValue}`;

    this.logger.log(
      `Triggering alert for rule ${rule.id}: ${message}`,
    );

    // Create alert history record
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

    // Publish alert event for notification service
    await this.eventBus.publish({
      eventId: crypto.randomUUID(),
      eventType: 'AlertTriggered',
      timestamp: new Date(),
      payload: {
        alertId: savedHistory.id,
        ruleId: rule.id,
        ruleName: rule.name,
        tenantId: reading.tenantId,
        severity: condition.severity,
        message,
        channels: rule.notificationChannels || [],
        recipients: rule.recipients || [],
        triggeringData: savedHistory.triggeringData,
      },
      metadata: {
        tenantId: reading.tenantId,
        source: 'alert-engine',
      },
    });
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
