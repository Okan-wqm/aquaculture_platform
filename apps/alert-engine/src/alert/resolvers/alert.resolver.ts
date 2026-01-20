import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
} from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { Tenant, CurrentUser, Roles, Role } from '@platform/backend-common';
import { AlertRule, AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { AlertRuleService } from '../services/alert-rule.service';
import {
  CreateAlertRuleInput,
  UpdateAlertRuleInput,
  AcknowledgeAlertInput,
} from '../dto/create-alert-rule.dto';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Alert Resolver
 * GraphQL resolver for alert operations
 */
@Resolver(() => AlertRule)
export class AlertResolver {
  private readonly logger = new Logger(AlertResolver.name);

  constructor(private readonly alertRuleService: AlertRuleService) {}

  /**
   * Get an alert rule by ID
   */
  @Query(() => AlertRule, { name: 'alertRule', nullable: true })
  async getAlertRule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<AlertRule> {
    return await this.alertRuleService.getRule(id, tenantId);
  }

  /**
   * List all alert rules for the tenant
   */
  @Query(() => [AlertRule], { name: 'alertRules' })
  async listAlertRules(
    @Tenant() tenantId: string,
    @Args('farmId', { type: () => ID, nullable: true }) farmId?: string,
    @Args('pondId', { type: () => ID, nullable: true }) pondId?: string,
    @Args('isActive', { type: () => Boolean, nullable: true }) isActive?: boolean,
  ): Promise<AlertRule[]> {
    return await this.alertRuleService.listRules(tenantId, {
      farmId,
      pondId,
      isActive,
    });
  }

  /**
   * Get alert history
   */
  @Query(() => [AlertHistory], { name: 'alertHistory' })
  async getAlertHistory(
    @Tenant() tenantId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('ruleId', { type: () => ID, nullable: true }) ruleId?: string,
    @Args('severity', { type: () => AlertSeverity, nullable: true }) severity?: AlertSeverity,
    @Args('acknowledged', { type: () => Boolean, nullable: true }) acknowledged?: boolean,
    @Args('startDate', { nullable: true }) startDate?: Date,
    @Args('endDate', { nullable: true }) endDate?: Date,
  ): Promise<AlertHistory[]> {
    const result = await this.alertRuleService.getAlertHistory(
      tenantId,
      { ruleId, severity, acknowledged, startDate, endDate },
      { page, limit },
    );
    return result.items;
  }

  /**
   * Create a new alert rule
   */
  @Mutation(() => AlertRule, { name: 'createAlertRule' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createAlertRule(
    @Args('input') input: CreateAlertRuleInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AlertRule> {
    this.logger.log(`Creating alert rule: ${input.name}`);

    return await this.alertRuleService.createRule({
      ...input,
      tenantId,
      createdBy: user.sub,
    });
  }

  /**
   * Update an alert rule
   */
  @Mutation(() => AlertRule, { name: 'updateAlertRule' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateAlertRule(
    @Args('input') input: UpdateAlertRuleInput,
    @Tenant() tenantId: string,
  ): Promise<AlertRule> {
    this.logger.log(`Updating alert rule: ${input.ruleId}`);

    const { ruleId, isActive, ...updates } = input;

    if (isActive !== undefined) {
      return await this.alertRuleService.toggleRule(ruleId, tenantId, isActive);
    }

    return await this.alertRuleService.updateRule(ruleId, tenantId, updates);
  }

  /**
   * Delete an alert rule
   */
  @Mutation(() => Boolean, { name: 'deleteAlertRule' })
  @Roles(Role.TENANT_ADMIN)
  async deleteAlertRule(
    @Args('ruleId', { type: () => ID }) ruleId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting alert rule: ${ruleId}`);
    return await this.alertRuleService.deleteRule(ruleId, tenantId);
  }

  /**
   * Acknowledge an alert
   */
  @Mutation(() => AlertHistory, { name: 'acknowledgeAlert' })
  async acknowledgeAlert(
    @Args('input') input: AcknowledgeAlertInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AlertHistory> {
    this.logger.log(`Acknowledging alert: ${input.alertId}`);

    return await this.alertRuleService.acknowledgeAlert(
      input.alertId,
      tenantId,
      user.sub,
      input.note,
    );
  }

  /**
   * Resolve an alert
   */
  @Mutation(() => AlertHistory, { name: 'resolveAlert' })
  async resolveAlert(
    @Args('alertId', { type: () => ID }) alertId: string,
    @Tenant() tenantId: string,
  ): Promise<AlertHistory> {
    this.logger.log(`Resolving alert: ${alertId}`);
    return await this.alertRuleService.resolveAlert(alertId, tenantId);
  }
}
