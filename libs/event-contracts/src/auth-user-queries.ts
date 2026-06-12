/**
 * Auth-service read-side NATS query contracts (request/reply — NOT
 * BaseEvent envelopes).
 *
 * WHY this exists (cluster-8 DİLİM-2, SEC class): messaging's channel
 * admission paths inserted arbitrary userIds as ChannelMembers without
 * ever proving the user belongs to the calling tenant (the
 * `create-channel.handler` "TODO Phase 2" gap). Tenant membership is
 * auth-service's truth; this contract lets tenant-owned services ask
 * for EXACTLY membership state — deliberately NO PII (no email, no
 * display name) so the query can never become a profile-harvesting
 * oracle.
 *
 * Subject naming follows the established `request.auth.<area>.<op>`
 * request/reply pattern (see tenant-commands.ts ADMIN/TENANT subjects),
 * NOT the event-stream `AQUACULTURE_EVENTS.*` namespace.
 */

export const AUTH_USER_QUERY_SUBJECTS = {
  VALIDATE_TENANT_MEMBERSHIP: 'request.auth.user.validateTenantMembership',
} as const;

/**
 * Hard upper bound on userIds per query — a single admission check
 * never legitimately needs more (channel member input caps at 200),
 * and an unbounded array would let one request fan a multi-thousand-row
 * lookup (DoS surface flagged by the security review).
 */
export const VALIDATE_TENANT_MEMBERSHIP_MAX_USER_IDS = 200;

/**
 * requireActive semantics are LOCKED (security review condition 6):
 *  - `true` (the admission default): an inactive member lands in
 *    `inactiveUserIds` AND forces `allValid: false` — admission is
 *    rejected. Ambiguity here would be a fail-open admission.
 *  - `false`: inactive members stay in `validUserIds`.
 */
export interface ValidateTenantMembershipQuery {
  tenantId: string;
  userIds: string[];
  requireActive?: boolean;
  correlationId?: string;
}

/**
 * Tenant-scoped answer: a userId that exists on the platform but
 * belongs to ANOTHER tenant lands in `invalidUserIds` exactly like a
 * nonexistent one — platform-wide existence must not leak through this
 * surface (userId-probing oracle, security review).
 */
export interface ValidateTenantMembershipResult {
  success: boolean;
  allValid: boolean;
  validUserIds: string[];
  invalidUserIds: string[];
  inactiveUserIds: string[];
  errorCode?: 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}
