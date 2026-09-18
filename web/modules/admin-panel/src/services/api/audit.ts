/**
 * Audit Logs API
 *
 * Methods a migrated page reads through `useAdminQuery` take a trailing
 * `AbortSignal` (ADMIN-HIGH-105). React Query hands the query function a signal
 * that is aborted when the component unmounts or the key changes; a client that
 * cannot accept one leaves the request running and its response is decoded into
 * a page that is gone. `ApiFetchOptions extends RequestInit`, so the transport
 * already carries it — only the domain signature was missing. The parameter is
 * added per method as its page migrates, so every call site the compiler knows
 * about keeps working unchanged.
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  AuditLog,
  AuditLogStats,
} from '../types';

export const auditApi = {
  query: (params?: {
    action?: string;
    entityType?: string;
    entityId?: string;
    tenantId?: string;
    performedBy?: string;
    severity?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    page?: number;
    limit?: number;
  }, signal?: AbortSignal) =>
    apiFetch<PaginatedResult<AuditLog>>(`/audit-logs?${buildQueryString(params || {})}`, { signal }),
  getEntityHistory: (entityType: string, entityId: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/entity/${entityType}/${entityId}?limit=${limit || 100}`),
  getUserActivity: (userId: string, startDate?: string, endDate?: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/user/${userId}?${buildQueryString({ startDate, endDate, limit })}`),
  getSecurityLogs: (tenantId?: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/security?${buildQueryString({ tenantId, limit })}`),
  getStatistics: (
    tenantId?: string,
    startDate?: string,
    endDate?: string,
    signal?: AbortSignal,
  ) =>
    apiFetch<AuditLogStats>(
      `/audit-logs/statistics?${buildQueryString({ tenantId, startDate, endDate })}`,
      { signal },
    ),
};
