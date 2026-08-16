/**
 * Impersonation API
 *
 * WHY the shapes below: every path, query param, request body, and response
 * envelope mirrors the backend ImpersonationController + ImpersonationService
 * contract (DB-ADMIN-HIGH-001). Reads return SafeImpersonationSession (no token
 * columns); only startSession's response carries the raw impersonation token.
 */

import { apiFetch } from '../http-client';
import type { StartImpersonationRequest } from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type GrantPermissionInput = AdminApiRouteBody<'POST /impersonation/permissions'>;
type PermissionQuery = AdminApiRouteQuery<'GET /impersonation/permissions'>;
type SessionQuery = AdminApiRouteQuery<'GET /impersonation/sessions'>;

export const impersonationApi = {
  // Permissions
  getPermissions: (params: PermissionQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /impersonation/permissions'], { query: params }),
  // Fix: backend uses superAdminId as path param (GET /permissions/:superAdminId)
  getPermission: (superAdminId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /impersonation/permissions/:superAdminId'], {
      path: { superAdminId: superAdminId },
    }),
  grantPermission: (data: GrantPermissionInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /impersonation/permissions'], { body: data }),
  // Fix: backend uses POST /permissions/:superAdminId/revoke (no body needed, auth from JWT)
  revokePermission: (superAdminId: string, _revokedBy?: string, _reason?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /impersonation/permissions/:superAdminId/revoke'], {
      path: { superAdminId: superAdminId },
    }),
  // Fix: backend uses path params GET /permissions/:superAdminId/check/:tenantId (not query params)
  checkPermission: (tenantId: string, adminId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /impersonation/permissions/:superAdminId/check/:tenantId'], {
      path: { superAdminId: adminId, tenantId: tenantId },
    }),

  // Sessions
  // Query and canonical page response are both generated from the backend
  // route-contract DAG; no local pagination envelope is maintained here.
  getSessions: (params: SessionQuery = {}, options?: { readonly signal?: AbortSignal }) =>
    apiFetch(ADMIN_API_ROUTES['GET /impersonation/sessions'], {
      query: params,
      signal: options?.signal,
    }),
  getSession: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /impersonation/sessions/:id'], { path: { id: id } }),
  startSession: (data: StartImpersonationRequest) =>
    apiFetch(ADMIN_API_ROUTES['POST /impersonation/sessions/start'], { body: data }),
  endSession: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /impersonation/sessions/:id/end'], {
      path: { id: id },
      body: {},
    }),
  extendSession: (id: string, additionalMinutes: number) =>
    apiFetch(ADMIN_API_ROUTES['POST /impersonation/sessions/:id/extend'], {
      path: { id: id },
      body: { additionalMinutes },
    }),
  // Backend TerminateSessionDto accepts ONLY { reason } (required); the
  // terminating admin's identity comes from the JWT, never the body.
  revokeSession: (id: string, reason: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /impersonation/sessions/:id/terminate'], {
      path: { id: id },
      body: { reason },
    }),
  getActiveSessions: () => apiFetch(ADMIN_API_ROUTES['GET /impersonation/sessions/active']),
  // Dashboard
  getImpersonationStats: () => apiFetch(ADMIN_API_ROUTES['GET /impersonation/stats']),
};
