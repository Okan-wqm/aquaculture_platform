/**
 * Impersonation domain types
 *
 * RBAC-MEDIUM-010 (M12): these types MIRROR the admin-api entities and DTOs
 * (`apps/admin-api-service/src/impersonation/`) field-for-field. The previous
 * shapes were an invented read model (tenantName/adminEmail/startedAt/
 * sessionToken/…) that matched NOTHING the backend returns — every list
 * rendered empty or undefined and the start call 400'd. Keep these in
 * lockstep with the backend entity; do not re-invent field names client-side.
 */

/** Mirrors admin-api ImpersonationStatus. */
export type ImpersonationSessionStatus = 'active' | 'ended' | 'expired' | 'terminated';

/** Mirrors admin-api ImpersonationReason (StartImpersonationDto.reason enum). */
export const IMPERSONATION_REASONS = [
  'support_request',
  'debugging',
  'configuration',
  'onboarding_assistance',
  'security_investigation',
  'data_verification',
  'other',
] as const;
export type ImpersonationReasonValue = (typeof IMPERSONATION_REASONS)[number];

/**
 * Mirrors admin-api IMPERSONATION_MAX_SESSION_MINUTES (the 1-hour policy
 * ceiling enforced by the backend DTOs and service clamps — RBAC-MEDIUM-009).
 */
export const IMPERSONATION_MAX_SESSION_MINUTES = 60;

/** Mirrors the ImpersonationPermissions jsonb on sessions/permissions. */
export interface ImpersonationCapabilities {
  [key: string]: unknown;
}

/** One entry of the session's append-only actionsPerformed jsonb log. */
export interface ImpersonationAction {
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

/** Mirrors admin-api ImpersonationSession (admin.impersonation_sessions). */
export interface ImpersonationSession {
  id: string;
  superAdminId: string;
  superAdminEmail?: string | null;
  targetTenantId: string;
  targetTenantName?: string | null;
  targetUserId?: string | null;
  targetUserEmail?: string | null;
  status: ImpersonationSessionStatus;
  reason: ImpersonationReasonValue;
  reasonDetails?: string | null;
  ticketReference?: string | null;
  permissions?: ImpersonationCapabilities | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  mfaCompleted: boolean;
  expiresAt: string;
  endedAt?: string | null;
  endReason?: string | null;
  actionsPerformed?: ImpersonationAction[] | null;
  actionCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors admin-api ImpersonationPermission (admin.impersonation_permissions). */
export interface ImpersonationPermission {
  id: string;
  superAdminId: string;
  superAdminEmail?: string | null;
  canImpersonate: boolean;
  isActive: boolean;
  allowedTenants?: string[] | null;
  restrictedTenants?: string[] | null;
  defaultPermissions?: ImpersonationCapabilities | null;
  maxSessionDurationMinutes: number;
  maxConcurrentSessions: number;
  requireReason: boolean;
  requireTicketReference: boolean;
  notifyTenantAdmin: boolean;
  grantedBy?: string | null;
  grantedAt?: string | null;
  expiresAt?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}
