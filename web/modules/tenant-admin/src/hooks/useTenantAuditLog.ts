/**
 * useTenantAuditLog Hook
 *
 * Fetches audit log entries for the current tenant with server-side
 * filtering, pagination, and CSV export support.
 *
 * Uses TanStack Query for data fetching and caching.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTenantQueryKey, getTenantId } from '@aquaculture/shared-ui';
import { useState, useCallback, useMemo } from 'react';
import { graphqlRequest } from '../services/tenant-api.service';
import { TENANT_AUDIT_LOGS_QUERY } from '../graphql';
import { logError } from '../utils/error-handling';

// ============================================================================
// Types
// ============================================================================

export interface AuditLogEntry {
  id: string;
  performedBy: string;
  performedByEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  severity: 'info' | 'warning' | 'error' | 'critical';
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AuditLogFilters {
  startDate: string | null;
  endDate: string | null;
  action: string | null;
  severity: string | null;
  performedBy: string | null;
}

export interface AuditLogPage {
  data: AuditLogEntry[];
  total: number;
}

// ============================================================================
// Query Keys
// ============================================================================

// Tenant-scoped via createTenantQueryKey (['tenant', tenantId, …]); `all` is a
// function because the tenantId is only known at call time (web/CLAUDE.md
// FE-CRITICAL-014/015/016).
export const auditLogKeys = {
  all: () => createTenantQueryKey(getTenantId(), 'tenant-audit-log'),
  list: (filters: AuditLogFilters, page: number, pageSize: number) =>
    createTenantQueryKey(getTenantId(), 'tenant-audit-log', 'list', filters, page, pageSize),
};

// ============================================================================
// Hook
// ============================================================================

export function useTenantAuditLog(pageSize = 20) {
  const queryClient = useQueryClient();

  // State
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AuditLogFilters>({
    startDate: null,
    endDate: null,
    action: null,
    severity: null,
    performedBy: null,
  });

  // Computed offset
  const offset = (page - 1) * pageSize;

  // Build query variables
  const variables = useMemo(() => {
    const vars: Record<string, unknown> = {
      limit: pageSize,
      offset,
    };
    if (filters.startDate) vars.startDate = filters.startDate;
    if (filters.endDate) vars.endDate = filters.endDate;
    if (filters.action) vars.action = filters.action;
    if (filters.severity) vars.severity = filters.severity;
    if (filters.performedBy) vars.performedBy = filters.performedBy;
    return vars;
  }, [filters, pageSize, offset]);

  // Query
  const query = useQuery({
    queryKey: auditLogKeys.list(filters, page, pageSize),
    queryFn: async (): Promise<AuditLogPage> => {
      try {
        const data = await graphqlRequest<{ tenantAuditLogs: AuditLogPage }>(
          TENANT_AUDIT_LOGS_QUERY,
          variables,
        );
        return data.tenantAuditLogs;
      } catch (err) {
        logError('useTenantAuditLog', err);
        // Return empty result on error so UI still renders
        throw err;
      }
    },
    staleTime: 30 * 1000, // 30 seconds
    placeholderData: (previousData) => previousData,
  });

  // Actions
  const updateFilters = useCallback((newFilters: Partial<AuditLogFilters>) => {
    setFilters((prev) => ({ ...prev, ...newFilters }));
    setPage(1); // Reset to first page on filter change
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({
      startDate: null,
      endDate: null,
      action: null,
      severity: null,
      performedBy: null,
    });
    setPage(1);
  }, []);

  const goToPage = useCallback((p: number) => {
    setPage(p);
  }, []);

  const nextPage = useCallback(() => {
    setPage((prev) => prev + 1);
  }, []);

  const prevPage = useCallback(() => {
    setPage((prev) => Math.max(1, prev - 1));
  }, []);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: auditLogKeys.all() });
  }, [queryClient]);

  // CSV export
  const exportCsv = useCallback(() => {
    const entries = query.data?.data;
    if (!entries || entries.length === 0) return;

    const headers = ['Timestamp', 'Action', 'User', 'IP Address', 'Severity', 'Entity Type', 'Details'];
    const rows = entries.map((entry) => [
      new Date(entry.createdAt).toISOString(),
      entry.action,
      entry.performedByEmail || entry.performedBy,
      entry.ipAddress || '',
      entry.severity,
      entry.entityType,
      entry.details ? JSON.stringify(entry.details) : '',
    ]);

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [query.data]);

  // Total pages
  const totalPages = useMemo(() => {
    if (!query.data?.total) return 1;
    return Math.ceil(query.data.total / pageSize);
  }, [query.data?.total, pageSize]);

  return {
    // Data
    entries: query.data?.data ?? [],
    total: query.data?.total ?? 0,
    totalPages,

    // State
    page,
    pageSize,
    filters,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,

    // Actions
    updateFilters,
    resetFilters,
    goToPage,
    nextPage,
    prevPage,
    refresh,
    exportCsv,
  };
}
