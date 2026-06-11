/**
 * @aquaculture/shared-contracts — Public API
 *
 * Canonical enum and type definitions shared across all backend services
 * and frontend applications. This library is the single source of truth
 * for cross-cutting domain concepts that appear in multiple bounded contexts.
 *
 * Import from this barrel instead of from sub-paths.
 */

// ── Tenant ──
// TenantStatus is canonical in @platform/event-contracts (beside TenantPlan,
// the TenantStatusChanged event, and the lifecycle machine). It is NOT
// re-exported here: this lib's tsconfig is deliberately isolated (no cross-lib
// paths) so it cannot import event-contracts, and nothing consumes this barrel
// anyway. Keeping a second copy here would re-introduce the drift MT-HIGH-003
// eliminated. See docs/reviews/orphan-findings.md (shared-contracts is unwired).

// ── Plan & Billing ──
export { PlanTier } from './enums/plan-tier.enum';
export { SubscriptionStatus, BillingCycle, PlanVisibility } from './enums/billing.enum';

// ── Impersonation ──
export {
  ImpersonationStatus,
  ImpersonationReason,
} from './enums/impersonation.enum';
export type {
  ImpersonationPermissions,
  ImpersonationAction,
} from './enums/impersonation.enum';

// ── GDPR Data Requests ──
export { DataRequestType, DataRequestStatus } from './enums/data-request.enum';
