/**
 * Impersonation API
 *
 * RBAC-MEDIUM-010 (M12): every function here speaks the EXACT admin-api
 * controller contract (impersonation.controller.ts DTOs + service return
 * shapes). The previous version sent an invented payload
 * ({tenantId, adminId, reason: string}) that the whitelist ValidationPipe
 * rejected with 400, read `.data` from endpoints that return {items, total},
 * and threw "Not implemented" from getSessionActions even though the backend
 * stores the action log on the session row. Keep signatures in lockstep with
 * the backend DTOs.
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginationParams,
  ImpersonationPermission,
  ImpersonationSession,
  ImpersonationAction,
  ImpersonationReasonValue,
  ImpersonationSessionStatus,
} from '../types';

/** Backend list shape: querySessions/queryPermissions return { items, total }. */
export interface ImpersonationListResult<T> {
  items: T[];
  total: number;
}

export const impersonationApi = {
  // Permissions
  getPermissions: (params?: { tenantId?: string; isActive?: boolean } & PaginationParams) =>
    apiFetch<ImpersonationListResult<ImpersonationPermission>>(
      `/impersonation/permissions?${buildQueryString(params || {})}`,
    ),
  getPermission: (superAdminId: string) =>
    apiFetch<ImpersonationPermission>(`/impersonation/permissions/${superAdminId}`),
  // Mirrors GrantPermissionDto (superAdminId comes from the caller's admin
  // context; the backend re-derives grantedBy from the verified JWT).
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
    apiFetch<ImpersonationPermission>('/impersonation/permissions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  revokePermission: (superAdminId: string) =>
    apiFetch<void>(`/impersonation/permissions/${superAdminId}/revoke`, { method: 'POST' }),
  checkPermission: (adminId: string, tenantId: string) =>
    apiFetch<{ allowed: boolean; reason?: string }>(
      `/impersonation/permissions/${adminId}/check/${tenantId}`,
    ),

  // Sessions — QuerySessionsDto param names (superAdminId/targetTenantId).
  getSessions: (
    params?: {
      superAdminId?: string;
      targetTenantId?: string;
      status?: ImpersonationSessionStatus;
    } & PaginationParams,
  ) =>
    apiFetch<ImpersonationListResult<ImpersonationSession>>(
      `/impersonation/sessions?${buildQueryString(params || {})}`,
    ),
  getSession: (id: string) => apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}`),
  // Mirrors StartImpersonationDto: targetTenantId + enum reason are REQUIRED;
  // free text travels as reasonDetails. adminId is NEVER sent — the backend
  // derives the admin identity from the verified JWT.
  startSession: (data: {
    targetTenantId: string;
    targetUserId?: string;
    reason: ImpersonationReasonValue;
    reasonDetails?: string;
    ticketReference?: string;
    durationMinutes?: number;
  }) =>
    apiFetch<ImpersonationSession>('/impersonation/sessions/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  endSession: (id: string, reason?: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/end`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  extendSession: (id: string, additionalMinutes: number) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/extend`, {
      method: 'POST',
      body: JSON.stringify({ additionalMinutes }),
    }),
  // Mirrors TerminateSessionDto: { reason } is REQUIRED (and the only field —
  // the whitelist pipe rejects extras; the backend derives who from the JWT).
  terminateSession: (id: string, reason: string) =>
    apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/terminate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  getActiveSessions: () => apiFetch<ImpersonationSession[]>('/impersonation/sessions/active'),
  // The action log lives ON the session row (actionsPerformed jsonb) — read
  // it through GET /sessions/:id instead of a nonexistent /actions endpoint.
  getSessionActions: async (sessionId: string): Promise<ImpersonationAction[]> => {
    const session = await apiFetch<ImpersonationSession>(`/impersonation/sessions/${sessionId}`);
    return session.actionsPerformed ?? [];
  },
  logAction: (sessionId: string, data: Omit<ImpersonationAction, 'timestamp'>) =>
    apiFetch<void>(`/impersonation/sessions/${sessionId}/log-action`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

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
