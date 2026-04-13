/**
 * Canonical subscription plan tiers.
 *
 * This is the single source of truth for plan tier values across the entire
 * platform. Backend billing entities and frontend plan selectors MUST use this enum.
 *
 * ## Existing definitions reconciled
 * - billing-service `Subscription.planTier`: starter, professional, enterprise, custom
 * - admin-api `PlanDefinition.tier`: free, starter, professional, enterprise, custom
 * - admin-api analytics `SubscriptionReadOnly.planTier`: starter, professional, enterprise, custom
 * - frontend billing `PlanTier`: free, starter, professional, enterprise, custom
 * - auth-service `TenantPlan`: trial, starter, professional, enterprise (uses 'trial' instead of 'free')
 *
 * Values are lowercase to match billing-service database columns (source of truth for subscriptions).
 */
export enum PlanTier {
  /** Free tier — no payment required, limited features. */
  FREE = 'free',

  /** Time-limited trial with full feature access. */
  TRIAL = 'trial',

  /** Entry-level paid plan for small operations. */
  STARTER = 'starter',

  /** Mid-tier plan for growing operations with advanced features. */
  PROFESSIONAL = 'professional',

  /** Full-featured plan for large enterprises with SLA and dedicated support. */
  ENTERPRISE = 'enterprise',

  /** Custom-negotiated plan with bespoke limits and pricing. */
  CUSTOM = 'custom',
}
