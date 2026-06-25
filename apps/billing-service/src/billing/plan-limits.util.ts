import { TenantPlan, resolvePlanLimits } from '@platform/event-contracts';

import { PlanLimits } from './entities/subscription.entity';

/**
 * Project the canonical PLAN_CATALOG (SSoT in @platform/event-contracts) onto
 * billing's `PlanLimits` shape. billing.plans is the *value authority* for
 * these fields, so the catalog carries billing's intended numbers — this
 * projection simply selects the subset billing persists. The former hardcoded
 * `limits` objects in plan-seed.service.ts and the DEFAULT_LIMITS fallback in
 * tenant-subscription-requested.handler.ts both delegate here, so the numbers
 * exist exactly once.
 */
export function billingPlanLimitsFor(plan: TenantPlan): PlanLimits {
  const limits = resolvePlanLimits(plan);
  return {
    maxFarms: limits.maxFarms,
    maxPonds: limits.maxPonds,
    maxSensors: limits.maxSensors,
    maxUsers: limits.maxUsers,
    dataRetentionDays: limits.dataRetentionDays,
    alertsEnabled: limits.alertsEnabled,
    reportsEnabled: limits.reportsEnabled,
    apiAccessEnabled: limits.apiAccessEnabled,
    customIntegrationsEnabled: limits.customIntegrationsEnabled,
  };
}
