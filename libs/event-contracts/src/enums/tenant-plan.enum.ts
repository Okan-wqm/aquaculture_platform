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
