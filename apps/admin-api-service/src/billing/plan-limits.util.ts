import { BillingPlanTier, TenantPlan, resolvePlanLimits } from '@platform/event-contracts';

import type { PlanLimits } from './entities/plan-definition.entity';

/**
 * Map the admin billing tier onto the canonical `TenantPlan` catalog key. The
 * billing-only `CUSTOM` tier has no catalog entry (its limits are negotiated
 * per tenant); for the DEFAULT limits it inherits the fully-unlimited ENTERPRISE
 * allowance, which the admin can then override. `TRIAL` is intentionally absent —
 * it is a subscription STATUS in billing, never a sellable tier.
 */
const BILLING_TIER_TO_TENANT_PLAN: Record<BillingPlanTier, TenantPlan> = {
  [BillingPlanTier.FREE]: TenantPlan.FREE,
  [BillingPlanTier.STARTER]: TenantPlan.STARTER,
  [BillingPlanTier.PROFESSIONAL]: TenantPlan.PROFESSIONAL,
  [BillingPlanTier.ENTERPRISE]: TenantPlan.ENTERPRISE,
  [BillingPlanTier.CUSTOM]: TenantPlan.ENTERPRISE,
};

/**
 * Project the canonical PLAN_CATALOG (SSoT in @platform/event-contracts) onto
 * admin's richer 17-field `PlanLimits` shape (Faz D — D9). The numbers live
 * ONLY in plan-catalog.ts; here we select the admin fields and apply the single
 * field-name divergence (`maxStorageGb` → `storageGB`). Symmetric with billing's
 * `billingPlanLimitsFor`, so no per-plan limit number is hand-maintained in
 * admin-api and `tests/invariants/plan-limits-ssot.spec.ts` can prove it.
 */
export function adminPlanLimitsFor(tier: BillingPlanTier): PlanLimits {
  const limits = resolvePlanLimits(BILLING_TIER_TO_TENANT_PLAN[tier]);
  return {
    maxUsers: limits.maxUsers,
    maxFarms: limits.maxFarms,
    maxPonds: limits.maxPonds,
    maxSensors: limits.maxSensors,
    maxModules: limits.maxModules,
    storageGB: limits.maxStorageGb,
    dataRetentionDays: limits.dataRetentionDays,
    apiRateLimit: limits.apiRateLimit,
    alertsEnabled: limits.alertsEnabled,
    reportsEnabled: limits.reportsEnabled,
    customBrandingEnabled: limits.customBrandingEnabled,
    apiAccessEnabled: limits.apiAccessEnabled,
    customIntegrationsEnabled: limits.customIntegrationsEnabled,
    ssoEnabled: limits.ssoEnabled,
    auditLogEnabled: limits.auditLogEnabled,
    prioritySupport: limits.prioritySupport,
    dedicatedAccountManager: limits.dedicatedAccountManager,
  };
}
