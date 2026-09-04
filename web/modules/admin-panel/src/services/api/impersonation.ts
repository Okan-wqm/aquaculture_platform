/**
 * Impersonation API
 *
 * WHY the shapes below: every path, query param, request body, and response
 * envelope mirrors the backend ImpersonationController + ImpersonationService
 * contract (DB-ADMIN-HIGH-001). Reads return SafeImpersonationSession (no token
 * columns); only startSession's response carries the raw impersonation token.
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  ImpersonationAuditSummary,
  ImpersonationPermission,
  ImpersonationSession,
  ImpersonationSessionStatus,
  ImpersonationReasonCode,
  StartImpersonationRequest,
  StartImpersonationResponse,
  ImpersonationAction,
} from '../types';

export const impersonationApi = {
  // Permissions
  getPermissions: (params?: { tenantId?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<ImpersonationPermission>>(`/impersonation/permissions?${buildQueryString(params || {})}`),
  // Fix: backend uses superAdminId as path param (GET /permissions/:superAdminId)
  getPermission: (superAdminId: string) => apiFetch<ImpersonationPermission>(`/impersonation/permissions/${superAdminId}`),
  grantPermission: (data: {
    superAdminId: string;
    superAdminEmail?: string;
    allowedTenants?: string[];
    restrictedTenants?: string[];
    defaultPermissions?: Record<string, unknown>;
    maxSessionDurationMinutes?: number;
    maxConcurrentSessions?: number;
    requireReason?: boolean;
    requireTicketReference?: boolean;
    notifyTenantAdmin?: boolean;
    expiresAt?: string;
    notes?: string;
  }) =>
    apiFetch<ImpersonationPermission>('/impersonation/permissions', { method: 'POST', body: JSON.stringify(data) }),
  // TODO: No backend PUT endpoint for updating permissions (only POST grant and POST revoke)
  updatePermission: (_id: string, _data: Partial<ImpersonationPermission>) => {
    throw new Error('Not implemented: no backend PUT endpoint for /impersonation/permissions/:id. Use grant/revoke instead.');
  },
  // Fix: backend uses POST /permissions/:superAdminId/revoke (no body needed, auth from JWT)
  revokePermission: (superAdminId: string, _revokedBy?: string, _reason?: string) =>
    apiFetch<void>(`/impersonation/permissions/${superAdminId}/revoke`, { method: 'POST' }),
  // Fix: backend uses path params GET /permissions/:superAdminId/check/:tenantId (not query params)
  checkPermission: (tenantId: string, adminId: string) =>
    apiFetch<{ hasPermission: boolean; permission?: ImpersonationPermission }>(`/impersonation/permissions/${adminId}/check/${tenantId}`),

  // Sessions
  // Query params mirror backend QuerySessionsDto (superAdminId/targetTenantId,
  // not adminId/tenantId). The response is the canonical envelope:
  // `ImpersonationService.querySessions` mints it through
  // `createStandardPaginatedResult`, so the page numerics are real.
  getSessions: (
    params?: {
      superAdminId?: string;
      targetTenantId?: string;
      status?: ImpersonationSessionStatus;
      reason?: ImpersonationReasonCode;
    } & PaginationParams,
  ) =>
    apiFetch<PaginatedResult<ImpersonationSession>>(
      `/impersonation/sessions?${buildQueryString(params || {})}`,
    ),
  getSession: (id: string) => apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}`),
  startSession: (data: StartImpersonationRequest) =>
    apiFetch<StartImpersonationResponse>('/impersonation/sessions/start', { method: 'POST', body: JSON.stringify(data) }),
  endSession: (id: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/end`, { method: 'POST' }),
  extendSession: (id: string, additionalMinutes: number) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/extend`, { method: 'POST', body: JSON.stringify({ additionalMinutes }) }),
  // Backend TerminateSessionDto accepts ONLY { reason } (required); the
  // terminating admin's identity comes from the JWT, never the body.
  revokeSession: (id: string, reason: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/terminate`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getActiveSessions: () => apiFetch<ImpersonationSession[]>('/impersonation/sessions/active'),
  // TODO: No backend GET endpoint for session actions
  getSessionActions: (_sessionId: string): Promise<ImpersonationAction[]> => {
    throw new Error('Not implemented: no backend GET endpoint for /impersonation/sessions/:id/actions');
  },
  // Fix: backend uses POST /sessions/:id/log-action (not /sessions/:id/actions)
  logAction: (sessionId: string, data: Omit<ImpersonationAction, 'timestamp'>) =>
    apiFetch<void>(`/impersonation/sessions/${sessionId}/log-action`, { method: 'POST', body: JSON.stringify(data) }),

  /**
   * The platform-wide impersonation aggregate.
   *
   * This replaces `getImpersonationStats()` / `GET /impersonation/stats`, which
   * was deleted along with its handler. The two endpoints computed overlapping
   * aggregates over different periods — one all-time and unparameterised, one
   * windowed — and having both is what let the page render the all-time count
   * under a "(30d)" heading. One endpoint owns the semantics now, and it
   * reports the window it used.
   */
  getAuditSummary: (startDate?: string, endDate?: string) =>
    apiFetch<ImpersonationAuditSummary>(
      `/impersonation/audit/summary?${buildQueryString({ startDate, endDate })}`,
    ),
};
