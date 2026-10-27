import { Resolver, Query, Mutation, Args, Int, ID } from '@nestjs/graphql';
import { Logger, ParseUUIDPipe } from '@nestjs/common';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { AlertRule, AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { ActiveAlertCount, ActiveAlertCountDimension } from '../dto/active-alert-count.type';
import { AlertHistoryOrder } from '../dto/alert-history-order.enum';
import type { OwnerModuleCode } from '@aquaculture/shared-contracts';
import { ALERT_MODULE_ENUM } from '../entities/alert-module.enum';
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
   * Get alert history. `severity` narrows to one severity (AquaMobil, which
   * ships as an installed PWA and keeps sending it); `severities` to a set —
   * one alarm priority of the tenant console spans several (P3 = MEDIUM +
   * WARNING); `resolved` to the open (false) or the cleared (true) alarms —
   * an annunciator tile counts open alarms only, and the list it opens must
   * hold the same rows; `siteId` / `module` to one site's or one module's
   * alarms (a module dashboard's alarm panel). Absent, a filter does not
   * narrow. `orderBy` pages the newest first (absent or null) or the most
   * severe first (AlertHistoryOrder) — a panel that reads only the first
   * rows asks for the most severe, so the limit never drops an older P1.
   *
   * WHY every filter argument is typed `T | null`: the schema declares them
   * nullable, and graphql-js hands an explicit `null` (e.g. a client sending
   * `severities: list.length ? list : null`) to the resolver as null, not
   * undefined. Here, at the trust boundary, an explicit null means what an
   * absent argument means — no filter — so each is turned into the service's
   * "absent" (undefined) once; the honest type makes the compiler demand it,
   * and the service never sees a null. The dates name their scalar
   * explicitly: a `Date | null` parameter reflects as Object. `siteId` is
   * parsed as a UUID here (ALERT-LOW-014): `site_id` is a uuid column, and a
   * value that is not one is a validation error, never a database error.
   */
  @Query(() => [AlertHistory], { name: 'alertHistory' })
  async getAlertHistory(
    @Tenant() tenantId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) rawLimit: number,
    @Args('ruleId', { type: () => ID, nullable: true }) ruleId?: string | null,
    @Args('severity', { type: () => AlertSeverity, nullable: true })
    severity?: AlertSeverity | null,
    @Args('severities', { type: () => [AlertSeverity], nullable: true })
    severities?: AlertSeverity[] | null,
    @Args('acknowledged', { type: () => Boolean, nullable: true }) acknowledged?: boolean | null,
    @Args('resolved', { type: () => Boolean, nullable: true }) resolved?: boolean | null,
    @Args('startDate', { type: () => Date, nullable: true }) startDate?: Date | null,
    @Args('endDate', { type: () => Date, nullable: true }) endDate?: Date | null,
    @Args('siteId', { type: () => ID, nullable: true }, new ParseUUIDPipe({ optional: true }))
    siteId?: string | null,
    @Args('module', { type: () => ALERT_MODULE_ENUM, nullable: true })
    module?: OwnerModuleCode | null,
    @Args('orderBy', { type: () => AlertHistoryOrder, nullable: true })
    orderBy?: AlertHistoryOrder | null,
  ): Promise<AlertHistory[]> {
    const limit = Math.min(Math.max(1, rawLimit), 100);
    const result = await this.alertRuleService.getAlertHistory(
      tenantId,
      {
        ruleId: ruleId ?? undefined,
        severity: severity ?? undefined,
        severities: severities ?? undefined,
        acknowledged: acknowledged ?? undefined,
        resolved: resolved ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        siteId: siteId ?? undefined,
        module: module ?? undefined,
      },
      { page, limit },
      orderBy ?? AlertHistoryOrder.NEWEST_FIRST,
    );
    return result.items;
  }

  /**
   * Unresolved alarms counted per severity and acknowledgement — exact, for
   * the tenant console's annunciator (ActiveAlertCount). Readable by whoever
   * may read alertHistory: the counts summarise the same rows. `siteId` /
   * `module` narrow them like the list; `groupBy` splits them per site and/or
   * module (the workspace menu, a module dashboard's site rows). Without
   * arguments the rows keep the annunciator's shape. An explicit null means
   * what an absent argument means, and `siteId` is parsed as a UUID, as on
   * alertHistory.
   */
  @Query(() => [ActiveAlertCount], { name: 'activeAlertCounts' })
  async getActiveAlertCounts(
    @Tenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }, new ParseUUIDPipe({ optional: true }))
    siteId?: string | null,
    @Args('module', { type: () => ALERT_MODULE_ENUM, nullable: true })
    module?: OwnerModuleCode | null,
    @Args('groupBy', { type: () => [ActiveAlertCountDimension], nullable: true })
    groupBy?: ActiveAlertCountDimension[] | null,
  ): Promise<ActiveAlertCount[]> {
    return await this.alertRuleService.countActiveAlerts(tenantId, {
      siteId: siteId ?? undefined,
      module: module ?? undefined,
      groupBy: groupBy ?? undefined,
    });
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

    // Apply all field updates first, then toggle isActive if specified
    // Previously, isActive would silently discard other field updates
    let rule: AlertRule;
    if (Object.keys(updates).length > 0) {
      rule = await this.alertRuleService.updateRule(ruleId, tenantId, updates);
    } else {
      rule = await this.alertRuleService.getRule(ruleId, tenantId);
    }

    if (isActive !== undefined) {
      rule = await this.alertRuleService.toggleRule(ruleId, tenantId, isActive);
    }

    return rule;
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async resolveAlert(
    @Args('alertId', { type: () => ID }) alertId: string,
    @Tenant() tenantId: string,
  ): Promise<AlertHistory> {
    this.logger.log(`Resolving alert: ${alertId}`);
    return await this.alertRuleService.resolveAlert(alertId, tenantId);
  }
}
