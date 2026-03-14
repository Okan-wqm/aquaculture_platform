/**
 * Audit Logs API
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
  }) => apiFetch<PaginatedResult<AuditLog>>(`/audit-logs?${buildQueryString(params || {})}`),
  getEntityHistory: (entityType: string, entityId: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/entity/${entityType}/${entityId}?limit=${limit || 100}`),
  getUserActivity: (userId: string, startDate?: string, endDate?: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/user/${userId}?${buildQueryString({ startDate, endDate, limit })}`),
  getSecurityLogs: (tenantId?: string, limit?: number) =>
    apiFetch<AuditLog[]>(`/audit-logs/security?${buildQueryString({ tenantId, limit })}`),
  getStatistics: (tenantId?: string, startDate?: string, endDate?: string) =>
    apiFetch<AuditLogStats>(`/audit-logs/statistics?${buildQueryString({ tenantId, startDate, endDate })}`),
};
