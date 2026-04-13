/**
 * Canonical billing-domain enums.
 *
 * Source of truth: billing-service `Subscription` entity and admin-api `PlanDefinition`.
 * Both backend billing logic and frontend billing/subscription UIs MUST use these enums.
 *
 * ## Existing definitions reconciled
 * - billing-service `Subscription`: SubscriptionStatus, BillingCycle
 * - admin-api `PlanDefinition`: BillingCycle, PlanVisibility
 * - frontend billing types: SubscriptionStatus, BillingCycle (match backend)
 *
 * Values are lowercase to match the database column values.
 */

/** Subscription lifecycle status. */
export enum SubscriptionStatus {
  /** Tenant is on a free trial period. */
  TRIAL = 'trial',

  /** Subscription is active and in good standing. */
  ACTIVE = 'active',

  /** Payment is overdue — grace period before suspension. */
  PAST_DUE = 'past_due',

  /** Subscription cancelled by tenant or admin. */
  CANCELLED = 'cancelled',

  /** Subscription suspended due to non-payment or policy violation. */
  SUSPENDED = 'suspended',

  /** Subscription period has ended without renewal. */
  EXPIRED = 'expired',
}

/** Billing cycle frequency for subscriptions. */
export enum BillingCycle {
  /** Billed every month. */
  MONTHLY = 'monthly',

  /** Billed every 3 months (typically with a small discount). */
  QUARTERLY = 'quarterly',

  /** Billed every 6 months. */
  SEMI_ANNUAL = 'semi_annual',

  /** Billed annually (typically with the largest discount). */
  ANNUAL = 'annual',
}

/** Plan visibility in the marketplace/plan selector. */
export enum PlanVisibility {
  /** Visible to all users in the plan selector. */
  PUBLIC = 'public',

  /** Only visible to admins — used for custom/negotiated plans. */
  PRIVATE = 'private',

  /** Plan is deprecated — visible to existing subscribers but not for new signups. */
  DEPRECATED = 'deprecated',
}
