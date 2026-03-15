/**
 * Impersonation API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  ImpersonationPermission,
  ImpersonationSession,
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
  getSessions: (params?: { adminId?: string; tenantId?: string; status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<ImpersonationSession>>(`/impersonation/sessions?${buildQueryString(params || {})}`),
  getSession: (id: string) => apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}`),
  startSession: (data: { tenantId: string; adminId: string; impersonatedUserId?: string; reason?: string }) =>
    apiFetch<ImpersonationSession>('/impersonation/sessions/start', { method: 'POST', body: JSON.stringify(data) }),
  endSession: (id: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/end`, { method: 'POST' }),
  extendSession: (id: string, additionalMinutes: number) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/extend`, { method: 'POST', body: JSON.stringify({ additionalMinutes }) }),
  // Fix: H21 -- backend path uyumu (revoke -> terminate)
  revokeSession: (id: string, revokedBy: string, reason?: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/terminate`, { method: 'POST', body: JSON.stringify({ revokedBy, reason }) }),
  getActiveSessions: () => apiFetch<ImpersonationSession[]>('/impersonation/sessions/active'),
  // TODO: No backend GET endpoint for session actions
  getSessionActions: (_sessionId: string) => {
    throw new Error('Not implemented: no backend GET endpoint for /impersonation/sessions/:id/actions');
  },
  // Fix: backend uses POST /sessions/:id/log-action (not /sessions/:id/actions)
  logAction: (sessionId: string, data: Omit<ImpersonationAction, 'id' | 'sessionId' | 'timestamp'>) =>
    apiFetch<void>(`/impersonation/sessions/${sessionId}/log-action`, { method: 'POST', body: JSON.stringify(data) }),

  // Dashboard
  getImpersonationStats: () =>
    apiFetch<{
      activeSessions: number;
      totalSessions: number;
      activePermissions: number;
      topAdmins: Array<{ adminId: string; email: string; sessionCount: number }>;
      recentSessions: ImpersonationSession[];
    }>('/impersonation/stats'),
};
