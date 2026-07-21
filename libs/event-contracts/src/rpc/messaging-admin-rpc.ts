/**
 * @module messaging-admin-rpc
 * @description Shared RPC contract for the admin-api ↔ messaging-service NATS
 * request-reply boundary (`request.messaging.admin.*`).
 *
 * This module is the single source of truth for the REQUEST payloads that
 * cross that boundary. Both sides import these types, so a field can never be
 * required on one side and silently dropped on the other:
 *
 * - messaging-service's `MessagingAdminNatsHandler` types every `@Payload()`
 *   from {@link MessagingAdminRpcRequest} (deleting its local payload copies).
 * - admin-api's `MessagingAdminController` constrains `sendNatsRequest`'s
 *   payload to `MessagingAdminRpcRequest[pattern]`, so omitting a required
 *   field — e.g. the dual-approver `approverId` / `releaseReason` on release —
 *   is a COMPILE error, not a click-time retried 502.
 *
 * That drift is exactly the APA-163 bug: the LEGAL-MEDIUM-002 dual-approver
 * retrofit widened the release contract at the command handler, the service
 * layer, and the DB CHECK constraint, but the admin proxy chain (hand-copied
 * untyped payload interfaces on each side of NATS) was never updated, so every
 * "Release" click failed at the deepest handler with no build/test/boundary
 * catch. A shared request contract makes that class of drift impossible.
 *
 * Response shapes are intentionally NOT part of this contract yet: the admin-api
 * REST response interfaces still drift from the wire truth (the compliance-stats
 * field mismatch APA-165 and the legal-hold enrichment gap APA-166). Reconciling
 * them is those findings' tracked scope; this module extends cleanly to a
 * response map when they land.
 *
 * @see ADR-012 Phase 3 (Compliance Admin API)
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/messaging-monitoring.md#APA-163
 */

/**
 * Minimum length (characters) of the free-text justification recorded when a
 * legal hold is released (dual-approver protocol, LEGAL-MEDIUM-002).
 *
 * SSoT: imported by messaging-service's `LegalHoldService` (service-layer guard,
 * with the DB CHECK constraint pinning it at the schema layer) AND admin-api's
 * `ReleaseLegalHoldDto` (`@MinLength` at the REST trust boundary). Keeping one
 * constant guarantees the boundary rejects the same sub-threshold reason the
 * deep handler would, surfacing a non-retried 400 instead of a retried 502.
 */
export const LEGAL_HOLD_MIN_RELEASE_REASON_CHARS = 50;

/**
 * NATS request-reply subjects for admin-panel messaging operations.
 * `as const` so each value is a string-literal type usable as a map key.
 */
export const MESSAGING_ADMIN_PATTERNS = {
  complianceStats: 'request.messaging.admin.complianceStats',
  getLegalHolds: 'request.messaging.admin.getLegalHolds',
  createLegalHold: 'request.messaging.admin.createLegalHold',
  releaseLegalHold: 'request.messaging.admin.releaseLegalHold',
  getRetentionPolicies: 'request.messaging.admin.getRetentionPolicies',
  updateRetentionPolicy: 'request.messaging.admin.updateRetentionPolicy',
  getAuditLog: 'request.messaging.admin.getAuditLog',
  triggerExport: 'request.messaging.admin.triggerExport',
  getPersonas: 'request.messaging.admin.getPersonas',
} as const;

/** Union of the concrete `request.messaging.admin.*` subject strings. */
export type MessagingAdminPattern =
  (typeof MESSAGING_ADMIN_PATTERNS)[keyof typeof MESSAGING_ADMIN_PATTERNS];

// ── Request payloads ─────────────────────────────────────────────────────

/** Every admin RPC is tenant-scoped. */
export interface TenantScopedRpcPayload {
  tenantId: string;
}

export type ComplianceStatsRequest = TenantScopedRpcPayload;
export type GetLegalHoldsRequest = TenantScopedRpcPayload;
export type GetRetentionPoliciesRequest = TenantScopedRpcPayload;
export type GetPersonasRequest = TenantScopedRpcPayload;

export interface CreateLegalHoldRequest extends TenantScopedRpcPayload {
  userId: string;
  channelId: string | null;
  reason: string;
  legalMatterId: string;
  legalMatterDescription?: string;
  requestedBy?: string;
  expiresAt?: string;
}

export interface ReleaseLegalHoldRequest extends TenantScopedRpcPayload {
  holdId: string;
  /** The SUPER_ADMIN committing the release. */
  userId: string;
  /**
   * The SECOND, distinct SUPER_ADMIN that countersigned the release
   * (dual-approver protocol, LEGAL-MEDIUM-002). MUST differ from `userId`.
   */
  approverId: string;
  /**
   * Free-text justification recorded on the row. Enforced ≥
   * {@link LEGAL_HOLD_MIN_RELEASE_REASON_CHARS} characters at every layer.
   */
  releaseReason: string;
}

export interface UpdateRetentionPolicyRequest extends TenantScopedRpcPayload {
  userId: string;
  channelId: string | null;
  retentionDays: number;
}

export interface GetAuditLogRequest extends TenantScopedRpcPayload {
  limit: number;
  cursor: string | null;
  userId?: string;
  /**
   * `ComplianceAction` value. Carried as a plain string so this contract stays
   * free of a messaging service-entity import; the handler narrows it back to
   * the enum with a value-set type guard (a bogus value is dropped, not cast).
   */
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
}

export interface TriggerExportRequest extends TenantScopedRpcPayload {
  userId: string;
  format: 'csv' | 'json';
}

/**
 * Pattern → request-payload map, keyed by the literal subject strings so that
 * `MessagingAdminRpcRequest[typeof MESSAGING_ADMIN_PATTERNS.releaseLegalHold]`
 * resolves to {@link ReleaseLegalHoldRequest}.
 */
export interface MessagingAdminRpcRequest {
  [MESSAGING_ADMIN_PATTERNS.complianceStats]: ComplianceStatsRequest;
  [MESSAGING_ADMIN_PATTERNS.getLegalHolds]: GetLegalHoldsRequest;
  [MESSAGING_ADMIN_PATTERNS.createLegalHold]: CreateLegalHoldRequest;
  [MESSAGING_ADMIN_PATTERNS.releaseLegalHold]: ReleaseLegalHoldRequest;
  [MESSAGING_ADMIN_PATTERNS.getRetentionPolicies]: GetRetentionPoliciesRequest;
  [MESSAGING_ADMIN_PATTERNS.updateRetentionPolicy]: UpdateRetentionPolicyRequest;
  [MESSAGING_ADMIN_PATTERNS.getAuditLog]: GetAuditLogRequest;
  [MESSAGING_ADMIN_PATTERNS.triggerExport]: TriggerExportRequest;
  [MESSAGING_ADMIN_PATTERNS.getPersonas]: GetPersonasRequest;
}
