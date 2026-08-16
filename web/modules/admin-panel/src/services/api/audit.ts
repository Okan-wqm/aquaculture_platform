/**
 * Audit Logs API
 */

import { apiFetch, apiFetchBlob } from '../http-client';
import type { StandardPaginatedResult, AuditLogDto, AuditStatisticsDto } from '../types';
import {
  ADMIN_API_ROUTES,
  ADMIN_BINARY_ROUTES,
  type AdminApiRouteQuery,
  type AdminBinaryRouteBody,
} from '../types/generated/admin-route-contracts';

type AuditLogQuery = AdminApiRouteQuery<'GET /audit-logs'>;
type AuditLogExportBody = AdminBinaryRouteBody<'POST /audit-logs/export'>;

export const auditApi = {
  query: (params: AuditLogQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /audit-logs'], { query: params }),
  getEntityHistory: (entityType: string, entityId: string, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /audit-logs/entity/:entityType/:entityId'], {
      path: { entityType: entityType, entityId: entityId },
      query: { limit: limit || 100 },
    }),
  getUserActivity: (userId: string, startDate?: string, endDate?: string, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /audit-logs/user/:userId'], {
      path: { userId: userId },
      query: { startDate, endDate, limit },
    }),
  getSecurityLogs: (tenantId?: string, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /audit-logs/security'], { query: { tenantId, limit } }),
  getStatistics: (tenantId?: string, startDate?: string, endDate?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /audit-logs/statistics'], {
      query: { tenantId, startDate, endDate },
    }),
  export: (body: AuditLogExportBody) =>
    apiFetchBlob(ADMIN_BINARY_ROUTES['POST /audit-logs/export'], { body }),
};
