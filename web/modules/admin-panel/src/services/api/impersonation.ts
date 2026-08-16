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
  ImpersonationPermission,
  GrantImpersonationPermissionRequest,
  ImpersonationPermissionCheck,
  ImpersonationPermissionRevocation,
  ImpersonationSession,
  ImpersonationSessionStatus,
  ImpersonationSessionScope,
  ImpersonationReasonCode,
  StartImpersonationRequest,
  StartImpersonationResponse,
  ImpersonationAction,
  ImpersonationStats,
} from '../types';

export const impersonationApi = {
  // Permissions
  getPermissions: (
    params?: { tenantId?: string; isActive?: boolean; search?: string } & PaginationParams,
  ) =>
    apiFetch<PaginatedResult<ImpersonationPermission>>(
      `/impersonation/permissions?${buildQueryString(params || {})}`,
    ),
  // Fix: backend uses superAdminId as path param (GET /permissions/:superAdminId)
  getPermission: (superAdminId: string) =>
    apiFetch<ImpersonationPermission | null>(`/impersonation/permissions/${superAdminId}`),
  grantPermission: (data: GrantImpersonationPermissionRequest) =>
    apiFetch<ImpersonationPermission>('/impersonation/permissions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  revokePermission: (superAdminId: string, data: ImpersonationPermissionRevocation) =>
    apiFetch<void>(`/impersonation/permissions/${superAdminId}/revoke`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Fix: backend uses path params GET /permissions/:superAdminId/check/:tenantId (not query params)
  checkPermission: (tenantId: string, adminId: string) =>
    apiFetch<ImpersonationPermissionCheck>(
      `/impersonation/permissions/${adminId}/check/${tenantId}`,
    ),

  // Sessions
  // Query params mirror backend QuerySessionsDto (superAdminId/targetTenantId,
  // not adminId/tenantId). The response uses the canonical page contract.
  getSessions: (
    params?: {
      superAdminId?: string;
      targetTenantId?: string;
      status?: ImpersonationSessionStatus;
      scope?: ImpersonationSessionScope;
      search?: string;
      reason?: ImpersonationReasonCode;
    } & PaginationParams,
  ) =>
    apiFetch<PaginatedResult<ImpersonationSession>>(
      `/impersonation/sessions?${buildQueryString(params || {})}`,
    ),
  getSession: (id: string) => apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}`),
  startSession: (data: StartImpersonationRequest) =>
    apiFetch<StartImpersonationResponse>('/impersonation/sessions/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  endSession: (id: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/end`, { method: 'POST' }),
  extendSession: (id: string, additionalMinutes: number) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/extend`, {
      method: 'POST',
      body: JSON.stringify({ additionalMinutes }),
    }),
  // Backend TerminateSessionDto accepts ONLY { reason } (required); the
  // terminating admin's identity comes from the JWT, never the body.
  revokeSession: (id: string, reason: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/terminate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  getActiveSessions: () => apiFetch<ImpersonationSession[]>('/impersonation/sessions/active'),
  getSessionActions: (sessionId: string): Promise<readonly ImpersonationAction[]> =>
    apiFetch<readonly ImpersonationAction[]>(`/impersonation/sessions/${sessionId}/actions`),
  // Fix: backend uses POST /sessions/:id/log-action (not /sessions/:id/actions)
  logAction: (sessionId: string, data: Omit<ImpersonationAction, 'timestamp'>) =>
    apiFetch<void>(`/impersonation/sessions/${sessionId}/log-action`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Dashboard
  getImpersonationStats: (windowDays = 30) =>
    apiFetch<ImpersonationStats>(`/impersonation/stats?${buildQueryString({ windowDays })}`),
};
