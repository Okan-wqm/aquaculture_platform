/**
 * TenantPlan — canonical SSoT (DBR-HIGH-003 cure)
 * ============================================================================
 *
 * # Why this lives in event-contracts
 *
 * Pre-fix three services declared their OWN copy of TenantPlan with
 * subtly different shapes:
 *
 *   - auth-service:         trial/starter/professional/enterprise
 *   - admin-api/tenant:     free/trial/starter/professional/enterprise
 *   - admin-api/analytics:  TRIAL/STARTER/PROFESSIONAL/ENTERPRISE (UPPERCASE)
 *
 * The analytics-side mirror's UPPERCASE values were a latent bug —
 * the actual DB rows use lowercase, so any equality query against
 * `TenantPlan.TRIAL` would NEVER match production data. Combined with
 * the casing drift, adding a plan to one service silently mismatched
 * the others.
 *
 * Canonical declaration here is the single source of truth. Each
 * service re-exports from this module so `TenantPlan` is structurally
 * identical everywhere.
 *
 * # Why lowercase
 *
 * The actual auth.tenants column stores lowercase values ('trial',
 * 'starter', etc.) — this matches what auth-service has always
 * persisted. The lowercase form also aligns with REST URL conventions
 * and the dashboard's plan-tier display logic. Switching to UPPERCASE
 * would require a data migration AND a bunch of dashboard / UI changes.
 * Lowercase is the cheaper-to-maintain canonical form.
 *
 * # FREE inclusion
 *
 * admin-api/tenant declares FREE; auth-service does not. Reviewing the
 * code paths, FREE is a legitimate tier (used for the always-free
 * developer-evaluation accounts). The canonical enum INCLUDES FREE so
 * the auth-service path that lacked it is the regression — including
 * FREE here is a strict superset, no service loses anything.
 */
export enum TenantPlan {
  FREE = 'free',
  TRIAL = 'trial',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

/**
 * Backwards-compatibility alias — some older code references TenantTier.
 * Two-token alias declaration (const + type) so both runtime and type
 * positions resolve identically.
 */
export const TenantTier = TenantPlan;
export type TenantTier = TenantPlan;

/**
 * PLAN_LEVEL — canonical tier ordinal SSoT (MT-MEDIUM-001).
 * ============================================================================
 *
 * The string enum values carry no inherent order, so "require at least
 * PROFESSIONAL" style feature gating previously needed an ad-hoc ordinal map
 * re-declared at each call site (a drift vector — one site could rank the tiers
 * differently from another). This is the single ordinal source of truth: a
 * higher number is a strictly higher tier.
 *
 * # Why TRIAL ranks at FREE
 *
 * TRIAL is NOT a paid tier — it is a billing/lifecycle STATE orthogonal to the
 * tier, and is derived from `trialEndsAt`, never from `plan` (MT-MEDIUM-001
 * collapse; production carries zero `plan = 'trial'` rows). The value survives
 * in the enum only for the billing-projection's backward compatibility. For
 * gating it maps to 0 (FREE-equivalent) because a trialing tenant has not
 * committed to any paid tier — it must not unlock paid-tier features by virtue
 * of the legacy `trial` plan string.
 *
 * The `Record<TenantPlan, number>` type makes the map exhaustive: adding a plan
 * to the enum without ranking it here is a compile error.
 */
export const PLAN_LEVEL: Record<TenantPlan, number> = {
  [TenantPlan.FREE]: 0,
  [TenantPlan.TRIAL]: 0,
  [TenantPlan.STARTER]: 1,
  [TenantPlan.PROFESSIONAL]: 2,
  [TenantPlan.ENTERPRISE]: 3,
};

/** The numeric tier rank for a plan (higher = more capable). */
export function planLevel(plan: TenantPlan): number {
  return PLAN_LEVEL[plan];
}

/**
 * Inverse of PLAN_LEVEL: map a numeric tier ordinal (the JWT `planLevel` claim)
 * back to a canonical TenantPlan for limit resolution.
 *
 * Because PLAN_LEVEL collapses FREE and TRIAL to 0, ordinal 0 maps to FREE —
 * the conservative floor. That is the correct fail-safe for QUOTA gating: a
 * trialing tenant (production carries ~zero such rows) is never granted more
 * than the free allowance by virtue of a lossy ordinal. Any out-of-range
 * ordinal also maps to FREE. Callers that have NO ordinal at all (platform
 * SUPER_ADMIN tokens carry none) must skip quota enforcement rather than pass a
 * default here — being capped at FREE would wrongly block privileged platform
 * operations.
 */
export function tenantPlanFromLevel(level: number): TenantPlan {
  switch (level) {
    case 1:
      return TenantPlan.STARTER;
    case 2:
      return TenantPlan.PROFESSIONAL;
    case 3:
      return TenantPlan.ENTERPRISE;
    default:
      return TenantPlan.FREE;
  }
}

/**
 * Parse an arbitrary (possibly externally-sourced) string to a canonical
 * `TenantPlan`, case-insensitively, or `undefined` if it is not a known plan.
 *
 * Why this lives here: pre-fix, gateway/tenant-lookup indexed their plan
 * catalogs with a raw `data.plan.toLowerCase()` string and silently fell back
 * to a default on a typo. Centralising the parse keeps the "what counts as a
 * valid plan" decision in the same module that owns the enum, so a new tier is
 * recognised everywhere the moment it is added here.
 */
export function toTenantPlan(
  value: string | null | undefined,
): TenantPlan | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return (Object.values(TenantPlan) as string[]).includes(normalized)
    ? (normalized as TenantPlan)
    : undefined;
}

/**
 * True when `plan` is at least `minimum` in the tier hierarchy. Use for feature
 * gating instead of equality chains. TRIAL (a state, not a tier) ranks at FREE,
 * so a trialing tenant never satisfies a paid-tier minimum via its plan string.
 */
export function planMeetsMinimum(
  plan: TenantPlan,
  minimum: TenantPlan,
): boolean {
  return PLAN_LEVEL[plan] >= PLAN_LEVEL[minimum];
}
