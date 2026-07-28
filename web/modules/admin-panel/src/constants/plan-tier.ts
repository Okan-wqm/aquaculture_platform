/**
 * Tier presentation — ONE author per vocabulary, and the two vocabularies kept apart.
 *
 * # There are two tier sets, and the panel used to conflate them
 *
 * `TenantPlan` is the ENTITLEMENT set — `free | trial | starter | professional
 * | enterprise`. It is what `auth.tenants.plan` stores, what `Tenant.tier` reads
 * back (that field is a getter over `plan`), and what the create/update/query
 * tenant DTOs validate with `@IsEnum(TenantPlan)`.
 *
 * `PlanTier` (canonically `BillingPlanTier`) is the SELLABLE set — `free |
 * starter | professional | enterprise | custom`. It is what
 * `billing.subscriptions.plan_tier` stores and what the quote, plan-catalogue
 * and custom-plan surfaces speak. It has no `trial`, because in billing "trial"
 * is a subscription STATUS, and it has `custom`, which must never reach
 * `TenantPlan` (a custom tenant has no catalogue entry to rank it by).
 *
 * The panel declared one hand-written `TenantTier` enum, pinned member-for-member
 * to the SELLABLE set, and handed it to the tenant endpoints — which validate the
 * ENTITLEMENT one. So the panel's types said it could send `custom` (the endpoint
 * 400s it) and said `trial` was impossible (the endpoint accepts it). Both sets
 * are now generated under their real names, so a call site cannot swap them by
 * accident.
 *
 * # The rule
 *
 * Every map here is an exhaustive `Record<…, …>`. Adding a member to either SSoT
 * regenerates its vocabulary and turns each map into a compile error until it is
 * given a label and a badge variant — there is no fallback branch to absorb it
 * silently. That is how `custom` went missing from the plan-catalogue surfaces
 * and how `TenantDetailPage` ended up keying its variant map on BOTH `enterprise`
 * and `ENTERPRISE`, because nobody knew which case the wire carried.
 *
 * @see libs/event-contracts/src/enums/tenant-plan.enum.ts — entitlement SSoT
 * @see libs/event-contracts/src/billing/billing-plan-tier.ts — sellable SSoT
 * @see tests/invariants/tier-enum-ssot.spec.ts — forbids a fresh copy of either
 */
import { PlanTier, TenantPlan } from '../services/types/generated/admin-contracts';

type BadgeVariant = 'success' | 'warning' | 'info' | 'default';

// ---------------------------------------------------------------------------
// Entitlement vocabulary — a tenant's plan
// ---------------------------------------------------------------------------

export const TENANT_PLAN_LABELS: Record<TenantPlan, string> = {
  [TenantPlan.FREE]: 'Free',
  [TenantPlan.TRIAL]: 'Trial',
  [TenantPlan.STARTER]: 'Starter',
  [TenantPlan.PROFESSIONAL]: 'Professional',
  [TenantPlan.ENTERPRISE]: 'Enterprise',
};

export const TENANT_PLAN_BADGE_VARIANT: Record<TenantPlan, BadgeVariant> = {
  [TenantPlan.FREE]: 'default',
  [TenantPlan.TRIAL]: 'warning',
  [TenantPlan.STARTER]: 'info',
  [TenantPlan.PROFESSIONAL]: 'warning',
  [TenantPlan.ENTERPRISE]: 'success',
};

/**
 * Every entitlement plan as a `<Select>` option, in catalogue order.
 *
 * Surfaces that legitimately offer a subset filter this list, so the exclusion
 * stays a visible decision rather than four inline literals that fall behind the
 * vocabulary. The create-tenant wizard excludes TRIAL because it expresses a
 * trial through `trialDays`, not through the plan.
 */
export const TENANT_PLAN_OPTIONS: ReadonlyArray<{ value: TenantPlan; label: string }> = [
  TenantPlan.FREE,
  TenantPlan.TRIAL,
  TenantPlan.STARTER,
  TenantPlan.PROFESSIONAL,
  TenantPlan.ENTERPRISE,
].map((plan) => ({ value: plan, label: TENANT_PLAN_LABELS[plan] }));

/** Runtime membership test, so a widget's `string` narrows instead of being cast. */
export const isTenantPlan = (value: string): value is TenantPlan =>
  Object.values(TenantPlan).some((plan) => plan === value);

// ---------------------------------------------------------------------------
// Sellable vocabulary — what billing prices
// ---------------------------------------------------------------------------

export const PLAN_TIER_LABELS: Record<PlanTier, string> = {
  [PlanTier.FREE]: 'Free',
  [PlanTier.STARTER]: 'Starter',
  [PlanTier.PROFESSIONAL]: 'Professional',
  [PlanTier.ENTERPRISE]: 'Enterprise',
  [PlanTier.CUSTOM]: 'Custom',
};

// ---------------------------------------------------------------------------
// Where the two vocabularies overlap
// ---------------------------------------------------------------------------

/**
 * A plan that is BOTH an entitlement plan and a sellable billing tier.
 *
 * The create-tenant wizard has one tier field that has to satisfy two contracts
 * at once: `POST /admin/tenants` validates it with `@IsEnum(TenantPlan)`, and
 * the quote request types it `PlanTier`. Only the overlap can do both, which is
 * why the wizard offers neither `trial` (an entitlement, not sellable — the
 * wizard expresses trials through `trialDays`) nor `custom` (sellable, not an
 * entitlement — issued by the custom-plan builder).
 *
 * DERIVED as an intersection rather than written out: both operands are unions
 * of string literals, so TypeScript computes the overlap itself. Add a member to
 * either SSoT and this recomputes — there is no hand-written list to fall behind.
 */
export type ProvisionablePlan = TenantPlan & PlanTier;

/** The same set at runtime, for building the wizard's options. */
export const PROVISIONABLE_PLANS: ReadonlyArray<ProvisionablePlan> = Object.values(
  TenantPlan,
).filter((plan): plan is ProvisionablePlan =>
  Object.values(PlanTier).some((tier) => tier === plan),
);
