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
  getPermission: (id: string) => apiFetch<ImpersonationPermission>(`/impersonation/permissions/${id}`),
  grantPermission: (data: {
    tenantId: string;
    grantedBy: string;
    expiresAt?: string;
    maxSessionDuration?: number;
    allowedActions?: string[];
    reason?: string;
  }) =>
    apiFetch<ImpersonationPermission>('/impersonation/permissions', { method: 'POST', body: JSON.stringify(data) }),
  updatePermission: (id: string, data: Partial<ImpersonationPermission>) =>
    apiFetch<ImpersonationPermission>(`/impersonation/permissions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  revokePermission: (id: string, revokedBy: string, reason?: string) =>
    apiFetch<ImpersonationPermission>(`/impersonation/permissions/${id}/revoke`, { method: 'POST', body: JSON.stringify({ revokedBy, reason }) }),
  checkPermission: (tenantId: string, adminId: string) =>
    apiFetch<{ hasPermission: boolean; permission?: ImpersonationPermission }>(`/impersonation/permissions/check?tenantId=${tenantId}&adminId=${adminId}`),

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
  getSessionActions: (sessionId: string) => apiFetch<ImpersonationAction[]>(`/impersonation/sessions/${sessionId}/actions`),
  logAction: (sessionId: string, data: Omit<ImpersonationAction, 'id' | 'sessionId' | 'timestamp'>) =>
    apiFetch<ImpersonationAction>(`/impersonation/sessions/${sessionId}/actions`, { method: 'POST', body: JSON.stringify(data) }),

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
