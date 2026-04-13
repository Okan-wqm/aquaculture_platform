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
export { TenantStatus } from './enums/tenant-status.enum';

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
