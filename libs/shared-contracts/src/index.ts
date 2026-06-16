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
// paths) so it cannot import event-contracts. Keeping a second copy here would
// re-introduce the drift MT-HIGH-003 eliminated.
//
// MSG-MEDIUM-057: this barrel is now consumed (the messaging media MIME
// allowlist below is imported by both messaging-service and the aquamobil PWA),
// so the previous "shared-contracts is unwired" note no longer holds.

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

// ── Messaging Media MIME Allowlist (MSG-MEDIUM-057) ──
// Single source of truth for the messaging media upload MIME allowlist, shared
// by the server trust boundary (media.service.ts) and the client UX path
// (useMediaUpload.ts / AttachmentPicker.tsx). Zero-dependency by design so it
// can be path-aliased into the standalone aquamobil Vite/Rollup bundle.
export { MESSAGING_MEDIA_MIME_ALLOWLIST } from './enums/messaging-media-mime';
export type { MessagingMediaMime } from './enums/messaging-media-mime';
