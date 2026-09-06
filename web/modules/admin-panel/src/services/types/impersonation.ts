/**
 * Impersonation domain types
 *
 * WHY these shapes: the read model mirrors the backend `SafeImpersonationSession`
 * (admin-api `impersonation-session.entity.ts`) field-for-field. Read responses
 * NEVER carry token columns (DB-ADMIN-HIGH-002); the raw impersonation token is
 * revealed exactly once, on the start response (DB-ADMIN-HIGH-001). Request
 * types mirror the controller DTOs — the super-admin identity always comes from
 * the verified JWT, never from the request body.
 */

/** Mirrors backend `ImpersonationStatus` — there is no 'revoked'; operator override is 'terminated'. */
export type ImpersonationSessionStatus = 'active' | 'ended' | 'expired' | 'terminated';

/** Mirrors backend `ImpersonationReason` — the start endpoint validates against this enum. */
export type ImpersonationReasonCode =
  | 'support_request'
  | 'debugging'
  | 'configuration'
  | 'onboarding_assistance'
  | 'security_investigation'
  | 'data_verification'
  | 'other';

export interface ImpersonationPermission {
  id: string;
  tenantId: string;
  tenantName: string;
  grantedBy: string;
  grantedByEmail: string;
  grantedAt: string;
  expiresAt?: string;
  maxSessionDuration: number;
  allowedActions: string[];
  isActive: boolean;
  reason?: string;
  revokedAt?: string;
  revokedBy?: string;
}

/**
 * Read model for GET /impersonation/sessions* — the backend's
 * SafeImpersonationSession. Optionality follows the entity's nullable columns.
 * `actionsPerformed` (the action array) is intentionally omitted: the UI only
 * consumes the numeric `actionCount`.
 */
export interface ImpersonationSession {
  id: string;
  superAdminId: string;
  superAdminEmail?: string;
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  status: ImpersonationSessionStatus;
  reason: ImpersonationReasonCode;
  reasonDetails?: string;
  ticketReference?: string;
  ipAddress?: string;
  userAgent?: string;
  mfaCompleted: boolean;
  expiresAt: string;
  endedAt?: string;
  endReason?: string;
  actionCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /impersonation/sessions/start response — the ONLY response that carries
 * the raw impersonation token (revealed once; reads never echo it back).
 */
export interface StartImpersonationResponse extends ImpersonationSession {
  impersonationToken: string;
}

/**
 * POST /impersonation/sessions/start request body (backend StartImpersonationDto).
 * No admin identity fields: the backend derives superAdminId from the JWT and
 * rejects unknown properties (forbidNonWhitelisted).
 */
export interface StartImpersonationRequest {
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  reason: ImpersonationReasonCode;
  reasonDetails?: string;
  ticketReference?: string;
  durationMinutes?: number;
}

/**
 * One entry of a session's action log — mirrors the backend `ImpersonationAction`
 * interface ({ action, resource, resourceId?, timestamp, details? }); the
 * log-action endpoint validates exactly these fields.
 */
export interface ImpersonationAction {
  action: string;
  resource: string;
  resourceId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

/**
 * The platform-wide impersonation aggregate — mirrors the backend
 * `ImpersonationAuditSummary` (apps/admin-api-service/src/impersonation/
 * services/impersonation.service.ts). Parity is pinned by
 * tests/invariants/admin-impersonation-summary-contract.spec.ts.
 *
 * The `InWindow` / `Now` suffixes are the contract, not decoration: this page
 * used to render an all-time session count under a hardcoded "(30d)" label and
 * sum `actionCount` over whatever rows the first unpaginated page happened to
 * return. Both numbers now come from the endpoint that owns the semantics, and
 * the period label is derived from `windowStart`/`windowEnd` rather than
 * written into the JSX.
 */
export interface ImpersonationAuditSummary {
  windowStart: string;
  windowEnd: string;
  totalSessionsInWindow: number;
  actionsLoggedInWindow: number;
  sessionsByReasonInWindow: Record<ImpersonationReasonCode, number>;
  topImpersonatorsInWindow: Array<{ adminId: string; email: string; sessionCount: number }>;
  topTargetTenantsInWindow: Array<{ tenantId: string; tenantName: string; sessionCount: number }>;
  recentSessionsInWindow: ImpersonationSession[];
  activeSessionsNow: number;
  activePermissionsNow: number;
}
