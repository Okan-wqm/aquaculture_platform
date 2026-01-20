import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import {
  AlertRule,
  AlertCondition,
  AlertOperator,
  AlertSeverity,
} from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';

/**
 * Create alert rule data
 */
export interface CreateAlertRuleData {
  name: string;
  description?: string;
  tenantId: string;
  farmId?: string;
  pondId?: string;
  sensorId?: string;
  conditions: AlertCondition[];
  notificationChannels?: string[];
  recipients?: string[];
  cooldownMinutes?: number;
  createdBy: string;
}

/**
 * Alert Rule Service
 * Manages alert rules CRUD operations
 */
@Injectable()
export class AlertRuleService {
  private readonly logger = new Logger(AlertRuleService.name);

  constructor(
    @InjectRepository(AlertRule)
    private readonly ruleRepository: Repository<AlertRule>,
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
  ) {}

  /**
   * Create a new alert rule
   */
  async createRule(data: CreateAlertRuleData): Promise<AlertRule> {
    // Check for duplicate name
    const existing = await this.ruleRepository.findOne({
      where: {
        name: data.name,
        tenantId: data.tenantId,
      },
    });

    if (existing) {
      throw new ConflictException(
        `Alert rule with name "${data.name}" already exists`,
      );
    }

    const rule = this.ruleRepository.create({
      ...data,
      isActive: true,
      cooldownMinutes: data.cooldownMinutes ?? 5,
    });

    const saved = await this.ruleRepository.save(rule);
    this.logger.log(`Created alert rule ${saved.id}: ${saved.name}`);

    return saved;
  }

  /**
   * Get alert rule by ID
   */
  async getRule(ruleId: string, tenantId: string): Promise<AlertRule> {
    const rule = await this.ruleRepository.findOne({
      where: { id: ruleId, tenantId },
    });

    if (!rule) {
      throw new NotFoundException(`Alert rule ${ruleId} not found`);
    }

    return rule;
  }

  /**
   * List alert rules for a tenant
   */
  async listRules(
    tenantId: string,
    filters?: {
      farmId?: string;
      pondId?: string;
      isActive?: boolean;
    },
  ): Promise<AlertRule[]> {
    const where: FindOptionsWhere<AlertRule> = { tenantId };

    if (filters?.farmId) {
      where.farmId = filters.farmId;
    }

    if (filters?.pondId) {
      where.pondId = filters.pondId;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    return await this.ruleRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Update alert rule
   */
  async updateRule(
    ruleId: string,
    tenantId: string,
    updates: Partial<CreateAlertRuleData>,
  ): Promise<AlertRule> {
    const rule = await this.getRule(ruleId, tenantId);

    // Apply updates
    if (updates.name) rule.name = updates.name;
    if (updates.description !== undefined) rule.description = updates.description;
    if (updates.farmId !== undefined) rule.farmId = updates.farmId;
    if (updates.pondId !== undefined) rule.pondId = updates.pondId;
    if (updates.sensorId !== undefined) rule.sensorId = updates.sensorId;
    if (updates.conditions) rule.conditions = updates.conditions;
    if (updates.notificationChannels !== undefined) {
      rule.notificationChannels = updates.notificationChannels;
    }
    if (updates.recipients !== undefined) {
      rule.recipients = updates.recipients;
    }
    if (updates.cooldownMinutes !== undefined) {
      rule.cooldownMinutes = updates.cooldownMinutes;
    }

    return await this.ruleRepository.save(rule);
  }

  /**
   * Toggle rule active status
   */
  async toggleRule(
    ruleId: string,
    tenantId: string,
    isActive: boolean,
  ): Promise<AlertRule> {
    const rule = await this.getRule(ruleId, tenantId);
    rule.isActive = isActive;

    return await this.ruleRepository.save(rule);
  }

  /**
   * Delete alert rule
   */
  async deleteRule(ruleId: string, tenantId: string): Promise<boolean> {
    const rule = await this.getRule(ruleId, tenantId);

    await this.ruleRepository.remove(rule);
    this.logger.log(`Deleted alert rule ${ruleId}`);

    return true;
  }

  /**
   * Get alert history for a tenant
   */
  async getAlertHistory(
    tenantId: string,
    filters?: {
      ruleId?: string;
      severity?: string;
      acknowledged?: boolean;
      startDate?: Date;
      endDate?: Date;
    },
    pagination?: { page: number; limit: number },
  ): Promise<{ items: AlertHistory[]; total: number }> {
    const query = this.historyRepository
      .createQueryBuilder('alert')
      .where('alert.tenantId = :tenantId', { tenantId });

    if (filters?.ruleId) {
      query.andWhere('alert.ruleId = :ruleId', { ruleId: filters.ruleId });
    }

    if (filters?.severity) {
      query.andWhere('alert.severity = :severity', {
        severity: filters.severity,
      });
    }

    if (filters?.acknowledged !== undefined) {
      query.andWhere('alert.acknowledged = :acknowledged', {
        acknowledged: filters.acknowledged,
      });
    }

    if (filters?.startDate) {
      query.andWhere('alert.triggeredAt >= :startDate', {
        startDate: filters.startDate,
      });
    }

    if (filters?.endDate) {
      query.andWhere('alert.triggeredAt <= :endDate', {
        endDate: filters.endDate,
      });
    }

    query.orderBy('alert.triggeredAt', 'DESC');

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

    query.skip(skip).take(limit);

    const [items, total] = await query.getManyAndCount();

    return { items, total };
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(
    alertId: string,
    tenantId: string,
    userId: string,
    note?: string,
  ): Promise<AlertHistory> {
    const alert = await this.historyRepository.findOne({
      where: { id: alertId, tenantId },
    });

    if (!alert) {
      throw new NotFoundException(`Alert ${alertId} not found`);
    }

    alert.acknowledged = true;
    alert.acknowledgedAt = new Date();
    alert.acknowledgedBy = userId;
    alert.acknowledgementNote = note;

    return await this.historyRepository.save(alert);
  }

  /**
   * Resolve an alert
   */
  async resolveAlert(alertId: string, tenantId: string): Promise<AlertHistory> {
    const alert = await this.historyRepository.findOne({
      where: { id: alertId, tenantId },
    });

    if (!alert) {
      throw new NotFoundException(`Alert ${alertId} not found`);
    }

    alert.resolved = true;
    alert.resolvedAt = new Date();

    return await this.historyRepository.save(alert);
  }
}
