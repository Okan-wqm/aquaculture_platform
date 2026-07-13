/**
 * BillingPlanTier — canonical SSoT for the billing/admin sellable-tier enum
 * ============================================================================
 *
 * # Why this exists (Billing Revival Faz D — D8 dedup)
 *
 * The billing + admin domain independently re-declared a `PlanTier` (and the
 * admin-panel a matching `TenantTier`) enum in FIVE places that had already
 * drifted — the analytics read-model even dropped `FREE`, so a FREE
 * subscription row could not map back to a tier. Those copies live at:
 *
 *   - apps/billing-service/.../entities/subscription.entity.ts   (GraphQL enum)
 *   - apps/admin-api-service/.../billing/entities/plan-definition.entity.ts
 *   - apps/admin-api-service/.../analytics/entities/external/subscription.entity.ts
 *   - web/modules/admin-panel/src/services/types/billing.ts       (PlanTier)
 *   - web/modules/admin-panel/src/services/types/tenant.ts        (TenantTier)
 *
 * Every backend copy now RE-EXPORTS this enum. The two frontend copies cannot
 * import an `@platform/*` library (web modules never bundle backend libs — see
 * the FE parity guard), so they keep a literal enum PINNED to this set by
 * `tests/invariants/tier-enum-ssot.spec.ts` (tier-3 make-it-detectable).
 *
 * # Why this is a DISTINCT enum from the canonical `TenantPlan`
 *
 * `TenantPlan` (tenant-plan.enum.ts) is the ENTITLEMENT/gating enum consumed by
 * auth + gateway for quota gating: free / trial / starter / professional /
 * enterprise. The billing domain sells a DIFFERENT set:
 *
 *   - It has NO `trial` — in billing, "trial" is a `SubscriptionStatus`, never a
 *     plan tier (billing's Postgres `subscriptions_plan_tier_enum` has no
 *     'trial' label).
 *   - It HAS `custom` — a negotiated per-tenant plan with bespoke limits
 *     (custom-plan.entity, module-pricing tier multipliers). `custom` must NOT
 *     leak into `TenantPlan`: a custom tenant has no catalog entry, so PLAN_LEVEL
 *     / PLAN_CATALOG gating would have nothing to rank it by.
 *
 * So the billing tier set = (canonical product tiers − TRIAL) + CUSTOM. The two
 * compile-time guards below LOCK the shared members to `TenantPlan` (tier-1
 * make-it-impossible): renaming a shared tier on either side, or adding a new
 * paid `TenantPlan` tier without a matching billing member, is a compile error.
 */
import { TenantPlan } from '../enums/tenant-plan.enum';

export enum BillingPlanTier {
  /** Permanent $0 tier (Billing Revival Faz B) — a real subscription row, no Stripe object. */
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  /** Negotiated per-tenant plan with bespoke limits — billing-domain only. */
  CUSTOM = 'custom',
}

/**
 * Backwards-compatible alias — the admin-panel frontend names this concept
 * `TenantTier` (a tenant's *sellable* tier, which CAN be `custom`). This differs
 * from event-contracts' `TenantTier` (an alias of the entitlement `TenantPlan`);
 * the FE `TenantTier` literal is pinned to THIS set by the tier-enum invariant.
 * Exported so a future FE-importable path resolves to one definition.
 */
export const BillingTenantTier = BillingPlanTier;
export type BillingTenantTier = BillingPlanTier;

// ---------------------------------------------------------------------------
// Compile-time drift guards (tier-1 make-it-impossible). Enforced by
// `tsc --noEmit` (npm run type-check), not by the transpile-only jest suite.
// `${Enum}` yields the enum's string-VALUE union, so the checks compare the
// persisted DB strings, not the nominal enum types.
// ---------------------------------------------------------------------------
type AssertTrue<T extends true> = T;

/**
 * (a) Every non-CUSTOM `BillingPlanTier` value is byte-identical to a canonical
 * `TenantPlan` value — the shared product tiers cannot silently diverge from the
 * SSoT (e.g. renaming `STARTER = 'starter'` on either side breaks compilation).
 */
export type SharedBillingTiersMatchCanonical = AssertTrue<
  Exclude<`${BillingPlanTier}`, 'custom'> extends `${TenantPlan}` ? true : false
>;

/**
 * (b) Every canonical product tier EXCEPT the `trial` lifecycle-state is a
 * sellable billing tier — adding a new paid tier to `TenantPlan` forces a
 * matching `BillingPlanTier` member (compile error until it is added here).
 */
export type CanonicalPaidTiersAreSellable = AssertTrue<
  Exclude<`${TenantPlan}`, 'trial'> extends `${BillingPlanTier}` ? true : false
>;
