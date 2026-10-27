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
import { ActiveAlertCount, ActiveAlertCountDimension } from '../dto/active-alert-count.type';
import { AlertHistoryOrder, severityRankSql } from '../dto/alert-history-order.enum';
import type { OwnerModuleCode } from '@aquaculture/shared-contracts';
import { AlertEvaluationService } from './alert-evaluation.service';
import { applyAlertHistoryScope, type AlertHistoryScope } from './alert-history-scope';

/** Narrowing and grouping of countActiveAlerts; every part optional. */
export interface ActiveAlertCountOptions extends AlertHistoryScope {
  readonly groupBy?: readonly ActiveAlertCountDimension[];
}

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
    private readonly evaluationService: AlertEvaluationService,
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

    try {
      const saved = await this.ruleRepository.save(rule);
      this.logger.log(`Created alert rule ${saved.id}: ${saved.name}`);
      await this.evaluationService.invalidateRuleCache(data.tenantId);
      return saved;
    } catch (error: unknown) {
      // Handle DB-level unique constraint violation for concurrent creates
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('23505')) {
        throw new ConflictException(
          `Alert rule with name "${data.name}" already exists`,
        );
      }
      throw error;
    }
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
    if (updates.name !== undefined && updates.name !== '') rule.name = updates.name;
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

    const saved = await this.ruleRepository.save(rule);
    await this.evaluationService.invalidateRuleCache(tenantId);
    return saved;
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

    const saved = await this.ruleRepository.save(rule);
    await this.evaluationService.invalidateRuleCache(tenantId);
    return saved;
  }

  /**
   * Delete alert rule
   */
  async deleteRule(ruleId: string, tenantId: string): Promise<boolean> {
    const rule = await this.getRule(ruleId, tenantId);

    await this.ruleRepository.remove(rule);
    await this.evaluationService.invalidateRuleCache(tenantId);
    this.logger.log(`Deleted alert rule ${ruleId}`);

    return true;
  }

  /**
   * Get alert history for a tenant.
   *
   * `severity` narrows to one severity (AquaMobil's filter); `severities` to a
   * set, because the tenant console reads alarms by priority and one priority
   * spans several severities (P3 = MEDIUM + WARNING, see web/shared-ui
   * AnnunciatorPriority). Given both, an alarm must pass both. An empty set
   * admits no severity, so it matches no alarm and is answered without a
   * query; an absent one reads every severity. `resolved` narrows to the open
   * (false) or the cleared (true) alarms: a tile counts open alarms only
   * (countActiveAlerts), and the list it opens must hold the same rows.
   * `siteId` / `module` narrow to one site's or one module's alarms — the
   * same scope the counts take (applyAlertHistoryScope). `order` pages the
   * newest first (default) or the most severe first (AlertHistoryOrder), so
   * a limited page never drops an older CRITICAL behind newer, milder rows.
   */
  async getAlertHistory(
    tenantId: string,
    filters?: AlertHistoryScope & {
      ruleId?: string;
      severity?: AlertSeverity;
      severities?: readonly AlertSeverity[];
      acknowledged?: boolean;
      resolved?: boolean;
      startDate?: Date;
      endDate?: Date;
    },
    pagination?: { page: number; limit: number },
    order: AlertHistoryOrder = AlertHistoryOrder.NEWEST_FIRST,
  ): Promise<{ items: AlertHistory[]; total: number }> {
    if (filters?.severities !== undefined && filters.severities.length === 0) {
      return { items: [], total: 0 };
    }

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

    if (filters?.severities !== undefined) {
      query.andWhere('alert.severity IN (:...severities)', {
        severities: filters.severities,
      });
    }

    if (filters?.acknowledged !== undefined) {
      query.andWhere('alert.acknowledged = :acknowledged', {
        acknowledged: filters.acknowledged,
      });
    }

    if (filters?.resolved !== undefined) {
      query.andWhere('alert.resolved = :resolved', { resolved: filters.resolved });
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

    applyAlertHistoryScope(query, filters);

    if (order === AlertHistoryOrder.MOST_SEVERE_FIRST) {
      query.orderBy(severityRankSql('alert'), 'DESC').addOrderBy('alert.triggeredAt', 'DESC');
    } else {
      query.orderBy('alert.triggeredAt', 'DESC');
    }
    // A unique last key: OFFSET paging over rows that tie on every other key
    // is otherwise free to repeat one row and skip another between pages.
    query.addOrderBy('alert.id', 'DESC');

    const MAX_LIMIT = 500;
    const page = pagination?.page || 1;
    const limit = Math.min(pagination?.limit || 20, MAX_LIMIT);
    const skip = (page - 1) * limit;

    query.skip(skip).take(limit);

    const [items, total] = await query.getManyAndCount();

    return { items, total };
  }

  /**
   * The tenant's unresolved alarms counted per (severity, acknowledged) — the
   * exact figures behind the console's annunciator (see ActiveAlertCount).
   * One grouped query, no paging, so a count can neither be capped nor lose a
   * row to newer ones; the (severity, acknowledged) index serves the grouping.
   * `options` narrows to a site and/or module (the alarm list's scope) and
   * splits the counts further per site and/or module (`groupBy`), for the
   * workspace menu and the module dashboards.
   */
  async countActiveAlerts(
    tenantId: string,
    options: ActiveAlertCountOptions = {},
  ): Promise<ActiveAlertCount[]> {
    const bySite = options.groupBy?.includes(ActiveAlertCountDimension.SITE) ?? false;
    const byModule = options.groupBy?.includes(ActiveAlertCountDimension.MODULE) ?? false;

    const query = this.historyRepository
      .createQueryBuilder('alert')
      .select('alert.severity', 'severity')
      .addSelect('alert.acknowledged', 'acknowledged')
      .addSelect('COUNT(*)', 'count')
      .where('alert.tenantId = :tenantId', { tenantId })
      .andWhere('alert.resolved = :resolved', { resolved: false });
    applyAlertHistoryScope(query, options);
    query.groupBy('alert.severity').addGroupBy('alert.acknowledged');
    if (bySite) query.addSelect('alert.siteId', 'siteId').addGroupBy('alert.siteId');
    if (byModule) query.addSelect('alert.module', 'module').addGroupBy('alert.module');

    const rows = await query.getRawMany<{
      severity: AlertSeverity;
      acknowledged: boolean;
      siteId?: string | null;
      module?: OwnerModuleCode | null;
      count: string;
    }>();

    // Postgres returns COUNT(*) as a bigint string. A dimension not grouped by
    // is left off the row, so GraphQL answers null for it.
    return rows.map((row) => ({
      severity: row.severity,
      acknowledged: row.acknowledged,
      ...(bySite ? { siteId: row.siteId ?? null } : {}),
      ...(byModule ? { module: row.module ?? null } : {}),
      count: Number.parseInt(row.count, 10),
    }));
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
