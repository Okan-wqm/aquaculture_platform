/**
 * PLAN_CATALOG — canonical plan-limit SSoT (SSOT-C-13 cure)
 * ============================================================================
 *
 * # Why this exists
 *
 * Pre-fix, the per-plan resource limits were hand-copied across FIVE
 * independent catalogs that had already drifted apart:
 *
 *   1. billing  `plan-seed.service.ts`            (billing.plans rows)
 *   2. billing  `tenant-subscription-requested`   (DEFAULT_LIMITS fallback)
 *   3. gateway  `tenant-context.middleware.ts`    (PLAN_LIMITS, hot path)
 *      + identical copy in `tenant-lookup.service.ts`
 *   4. admin    `plan-definition.service.ts`      (getDefaultLimitsForTier)
 *   5. auth     `tenant.service.ts`               (getDefaultMaxUsers)
 *
 * They disagreed on real product values — e.g. a STARTER tenant was told it
 * could register 20 sensors (billing) OR 50 sensors (gateway/admin), and
 * 5 users (billing/admin) OR 10 users (gateway/auth). Whichever service a
 * request happened to hit decided the limit, so the platform had no single
 * truth about what a customer actually bought.
 *
 * This constant is the ONE place those numbers live. Every former catalog is
 * deleted and PROJECTS its local shape from here (mapping field names where a
 * consumer's persisted shape differs — e.g. admin's `storageGB`). Because the
 * map is `Readonly<Record<TenantPlan, PlanLimits>>`, omitting a tier or a field
 * is a COMPILE error in every consumer (tier-1, make-it-impossible), and
 * `tests/invariants/plan-limits-ssot.spec.ts` forbids any new hand-copied
 * numeric catalog (tier-3, make-it-detectable).
 *
 * # Value authority (resolved 2026-06-25, owner decision)
 *
 * billing.plans is the value authority — billing is the SSoT for subscription
 * state (root CLAUDE.md D14). For the fields billing defines (farms/ponds/
 * sensors/users/retention + the four capability booleans) the billing-seed
 * numbers win; the gateway/admin "50 sensors / 10 users / api-on" variants are
 * standardised DOWN to billing's intent. Fields only one service ever defined
 * (maxApiRequests + maxStorageGb from gateway; maxModules + apiRateLimit + the
 * extended booleans from admin) are carried verbatim from that sole definer.
 * ENTERPRISE is fully unlimited (-1) everywhere — auth's stray `maxUsers: 500`
 * and billing's `dataRetentionDays: 730` were the outliers and are corrected.
 *
 * NOTE: `maxApiRequests` (total request budget) and `apiRateLimit` (requests
 * per minute) are DISTINCT concepts kept as separate fields — they are not a
 * naming collision. Only `storageGB`→`maxStorageGb` was a true rename.
 */
import { TenantPlan } from '../enums/tenant-plan.enum';

/**
 * Canonical superset of every plan-limit field any service consumes.
 * `-1` means "unlimited" for any numeric field (the platform-wide convention).
 */
export interface PlanLimits {
  /** Max active users. -1 = unlimited. */
  readonly maxUsers: number;
  /** Max farms/sites. -1 = unlimited. */
  readonly maxFarms: number;
  /** Max ponds/tanks. -1 = unlimited. */
  readonly maxPonds: number;
  /** Max registered sensors/devices. -1 = unlimited. */
  readonly maxSensors: number;
  /** Max enabled platform modules. -1 = unlimited. */
  readonly maxModules: number;
  /** Total API request budget (billing window). -1 = unlimited. */
  readonly maxApiRequests: number;
  /** Object-storage allowance in gigabytes. -1 = unlimited. */
  readonly maxStorageGb: number;
  /** Telemetry/data retention window in days. -1 = unlimited. */
  readonly dataRetentionDays: number;
  /** API rate limit in requests per minute. -1 = unlimited. */
  readonly apiRateLimit: number;

  readonly alertsEnabled: boolean;
  readonly reportsEnabled: boolean;
  readonly apiAccessEnabled: boolean;
  readonly customIntegrationsEnabled: boolean;
  readonly customBrandingEnabled: boolean;
  readonly ssoEnabled: boolean;
  readonly auditLogEnabled: boolean;
  readonly prioritySupport: boolean;
  readonly dedicatedAccountManager: boolean;
}

/**
 * The single source of truth for per-plan limits. Frozen so no consumer can
 * mutate a shared limit object at runtime. Keyed by the canonical `TenantPlan`
 * enum — the `Record` makes every tier mandatory at compile time.
 */
export const PLAN_CATALOG: Readonly<Record<TenantPlan, PlanLimits>> =
  Object.freeze({
    // FREE — always-free developer-evaluation accounts (billing has no FREE
    // row; values from the gateway/admin free tier, auth's maxUsers:3 over
    // admin's outlier 2).
    [TenantPlan.FREE]: Object.freeze({
      maxUsers: 3,
      maxFarms: 1,
      maxPonds: 5,
      maxSensors: 10,
      maxModules: 1,
      maxApiRequests: 1000,
      maxStorageGb: 1,
      dataRetentionDays: 30,
      apiRateLimit: 100,
      alertsEnabled: true,
      reportsEnabled: false,
      apiAccessEnabled: false,
      customIntegrationsEnabled: false,
      customBrandingEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: false,
      prioritySupport: false,
      dedicatedAccountManager: false,
    }),
    // TRIAL — a time-boxed paid-tier preview. It ranks at FREE for paid-feature
    // GATING (see PLAN_LEVEL) but its numeric allowances are generous so the
    // evaluator can exercise the product. Production carries ~zero plan='trial'
    // rows; values are the gateway trial limits + a starter-equivalent module/
    // rate cap.
    [TenantPlan.TRIAL]: Object.freeze({
      maxUsers: 10,
      maxFarms: 5,
      maxPonds: 25,
      maxSensors: 100,
      maxModules: 3,
      maxApiRequests: 50000,
      maxStorageGb: 10,
      dataRetentionDays: 90,
      apiRateLimit: 500,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: false,
      customBrandingEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: true,
      prioritySupport: false,
      dedicatedAccountManager: false,
    }),
    // STARTER — billing-authoritative (billing.plans): 3 farms / 30 ponds /
    // 20 sensors / 5 users, reports + apiAccess OFF. Non-billing fields from
    // their definers (gateway api/storage, admin modules/rate/auditLog).
    [TenantPlan.STARTER]: Object.freeze({
      maxUsers: 5,
      maxFarms: 3,
      maxPonds: 30,
      maxSensors: 20,
      maxModules: 3,
      maxApiRequests: 10000,
      maxStorageGb: 10,
      dataRetentionDays: 90,
      apiRateLimit: 500,
      alertsEnabled: true,
      reportsEnabled: false,
      apiAccessEnabled: false,
      customIntegrationsEnabled: false,
      customBrandingEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: true,
      prioritySupport: false,
      dedicatedAccountManager: false,
    }),
    // PROFESSIONAL — billing-authoritative: 10 farms / 100 ponds / 100 sensors /
    // 25 users, reports + apiAccess ON, customIntegrations OFF (billing seed).
    [TenantPlan.PROFESSIONAL]: Object.freeze({
      maxUsers: 25,
      maxFarms: 10,
      maxPonds: 100,
      maxSensors: 100,
      maxModules: -1,
      maxApiRequests: 100000,
      maxStorageGb: 100,
      dataRetentionDays: 365,
      apiRateLimit: 2000,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: false,
      customBrandingEnabled: true,
      ssoEnabled: false,
      auditLogEnabled: true,
      prioritySupport: true,
      dedicatedAccountManager: false,
    }),
    // ENTERPRISE — fully unlimited; every capability on.
    [TenantPlan.ENTERPRISE]: Object.freeze({
      maxUsers: -1,
      maxFarms: -1,
      maxPonds: -1,
      maxSensors: -1,
      maxModules: -1,
      maxApiRequests: -1,
      maxStorageGb: -1,
      dataRetentionDays: -1,
      apiRateLimit: -1,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: true,
      customBrandingEnabled: true,
      ssoEnabled: true,
      auditLogEnabled: true,
      prioritySupport: true,
      dedicatedAccountManager: true,
    }),
  });

/**
 * Resolve the canonical limits for a plan. Returns the frozen catalog entry —
 * callers that need a mutable copy (e.g. to project into a persisted shape with
 * different field names) should spread it.
 */
export function resolvePlanLimits(plan: TenantPlan): PlanLimits {
  return PLAN_CATALOG[plan];
}
