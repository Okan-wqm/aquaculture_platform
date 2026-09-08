/**
 * Audit Log Page
 *
 * System audit logs, read through the admin data layer (ADMIN-HIGH-105): every
 * fetch is a `useAdminQuery` keyed from `adminKeys`, so the cache lives in the
 * shell's `QueryClient` — cleared by `logoutCleanup()` and invalidatable by any
 * write — instead of the module-scoped Map `useAsyncData` owns.
 *
 * Two defects went with the move. The logs fetcher called
 * `pagination.setTotal(result.total)` from INSIDE the fetch, so a request that
 * lost its race still wrote its page count into the controller; the query now
 * returns the whole `PaginatedResult` and the total is synced from the settled
 * data. And the fetchers ignored cancellation entirely — they now forward the
 * `signal` React Query aborts on unmount and on every key change, so a fast
 * operator paging through no longer has four superseded requests in flight.
 */

import React, { useMemo, useState, useEffect } from 'react';
import { Card, Button, Input, Select, Badge, Table } from '@aquaculture/shared-ui';
import type { TableColumn } from '@aquaculture/shared-ui';
import { adminKeys, useAdminQuery, usePagination, useFilters } from '../hooks';
import { auditApi, tenantsApi } from '../services/adminApi';
import type {
  AuditLog,
  AuditLogStats,
  AuditSeverity,
  PaginatedResult,
  Tenant,
} from '../services/adminApi';
import { TenantTier, TenantStatus } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface AuditFilters extends Record<string, unknown> {
  search: string;
  action: string;
  severity: string;
  entityType: string;
  tenantId: string;
  startDate: string;
  endDate: string;
}

// ============================================================================
// Constants
// ============================================================================

/** One page of tenants is enough to populate a filter dropdown. */
const TENANT_FILTER_LIMIT = 100;

/** Export window; the list itself is paged. */
const EXPORT_ROW_LIMIT = 10000;

/**
 * The ONE place audit query params are assembled.
 *
 * The list read and the CSV export used to build this shape separately, and
 * they had already drifted: a `search` term the operator could see in the table
 * was missing from the export until it was patched in by hand. Sharing the
 * builder makes "the export matches what is on screen" structural rather than
 * a thing two call sites have to agree about.
 */
function buildAuditQueryParams(
  filters: AuditFilters,
  page: number,
  limit: number,
): Record<string, string> {
  const params: Record<string, string> = {
    page: page.toString(),
    limit: limit.toString(),
  };
  if (filters.action) params.action = filters.action;
  if (filters.severity) params.severity = filters.severity;
  if (filters.entityType) params.entityType = filters.entityType;
  if (filters.tenantId) params.tenantId = filters.tenantId;
  if (filters.search) params.search = filters.search;
  if (filters.startDate) params.startDate = filters.startDate;
  if (filters.endDate) params.endDate = filters.endDate;
  return params;
}

const INITIAL_FILTERS: AuditFilters = {
  search: '',
  action: '',
  severity: '',
  entityType: '',
  tenantId: '',
  startDate: '',
  endDate: '',
};

const ACTION_TYPES = [
  { value: '', label: 'All Actions' },
  { value: 'CREATE', label: 'Create' },
  { value: 'UPDATE', label: 'Update' },
  { value: 'DELETE', label: 'Delete' },
  { value: 'LOGIN', label: 'Login' },
  { value: 'LOGOUT', label: 'Logout' },
  { value: 'ASSIGN', label: 'Assign' },
  { value: 'REVOKE', label: 'Revoke' },
  { value: 'ACTIVATE', label: 'Activate' },
  { value: 'DEACTIVATE', label: 'Deactivate' },
  { value: 'SUSPEND', label: 'Suspend' },
];

const ENTITY_TYPES = [
  { value: '', label: 'All Entities' },
  { value: 'User', label: 'User' },
  { value: 'Tenant', label: 'Tenant' },
  { value: 'Module', label: 'Module' },
  { value: 'Farm', label: 'Farm' },
  { value: 'Sensor', label: 'Sensor' },
  { value: 'Alert', label: 'Alert' },
  { value: 'Setting', label: 'Setting' },
];

/**
 * The severities `admin.audit_logs` can actually hold.
 *
 * This offered Low, Medium and High — three values the column has never held
 * (ADMIN-HIGH-112). An auditor filtering for High got an empty list and read it
 * as "no high-severity events". Built from the contract union now, so a value
 * the API cannot return cannot be offered.
 */
const SEVERITY_LEVELS: Array<{ value: '' | AuditSeverity; label: string }> = [
  { value: '', label: 'All Severities' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

// ============================================================================
// Utilities
// ============================================================================

const formatDateTime = (dateStr: string): string => {
  return new Date(dateStr).toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatRelativeTime = (dateStr: string): string => {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDateTime(dateStr);
};

const getActionBadgeVariant = (action: string): 'success' | 'info' | 'error' | 'warning' | 'default' => {
  const variants: Record<string, 'success' | 'info' | 'error' | 'warning' | 'default'> = {
    CREATE: 'success',
    UPDATE: 'info',
    DELETE: 'error',
    LOGIN: 'default',
    LOGOUT: 'default',
    ASSIGN: 'info',
    REVOKE: 'warning',
    ACTIVATE: 'success',
    DEACTIVATE: 'error',
    SUSPEND: 'warning',
  };
  return variants[action] || 'default';
};

/**
 * Keyed on `AuditSeverity`, not on `string`: a `Record<string, …>` accepted
 * four keys the column never holds and silently defaulted the two it does, so
 * a `warning` row rendered grey like a routine one. Exhaustive over the real
 * union, adding a severity server-side is a compile error here.
 */
const getSeverityBadgeVariant = (
  severity: AuditSeverity,
): 'default' | 'info' | 'warning' | 'error' => {
  const variants: Record<AuditSeverity, 'default' | 'info' | 'warning' | 'error'> = {
    info: 'info',
    warning: 'warning',
    critical: 'error',
  };
  return variants[severity];
};

/**
 * Escape a CSV cell value to prevent formula injection and handle special characters.
 * Prefixes cells starting with =, +, -, @, \t, \r with a single quote inside double quotes.
 * Wraps cells containing commas, double quotes, or newlines in double quotes.
 */
function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  // Formula injection protection
  if (/^[=+\-@\t\r]/.test(str)) {
    return `"'${str.replace(/"/g, '""')}"`;
  }
  // Quote cells containing comma, double quote, or newline
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ============================================================================
// Sub-components
// ============================================================================

interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  valueColor?: string;
}

const StatsCard: React.FC<StatsCardProps> = ({ title, value, subtitle, valueColor = 'text-gray-900' }) => (
  <Card className="p-4">
    <p className="text-sm text-gray-500">{title}</p>
    <p className={`text-2xl font-bold ${valueColor}`}>{typeof value === 'number' ? value.toLocaleString() : value}</p>
    {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
  </Card>
);

interface LogDetailModalProps {
  log: AuditLog;
  onClose: () => void;
}

const LogDetailModal: React.FC<LogDetailModalProps> = ({ log, onClose }) => (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <Card className="w-full max-w-2xl max-h-[90vh] overflow-auto">
      <div className="p-6">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Log Details</h2>
            <p className="text-sm text-gray-500">ID: {log.id}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <DetailField label="Date" value={formatDateTime(log.createdAt)} />
            <DetailField label="Action">
              <Badge variant={getActionBadgeVariant(log.action)}>{log.action}</Badge>
            </DetailField>
            <DetailField label="Entity Type" value={log.entityType} />
            <DetailField label="Entity ID" value={log.entityId} mono />
            <DetailField label="User" value={log.performedByEmail} subtitle={log.performedBy} />
            <DetailField label="Severity">
              <Badge variant={getSeverityBadgeVariant(log.severity)}>{log.severity}</Badge>
            </DetailField>
            <DetailField label="IP Address" value={log.ipAddress} mono />
            <DetailField label="Tenant ID" value={log.tenantId || '-'} mono />
          </div>

          <div>
            <label className="text-xs text-gray-500">User Agent</label>
            <p className="text-sm text-gray-600 bg-gray-50 p-2 rounded break-all">
              {log.userAgent || '-'}
            </p>
          </div>

          {log.details && Object.keys(log.details).length > 0 && (
            <div>
              {/* `details` is the column (audit.entity.ts). The hand-written
                  type called it `metadata`, so this block never rendered. */}
              <label className="text-xs text-gray-500">Details</label>
              <pre className="text-sm bg-gray-50 p-3 rounded overflow-auto max-h-64">
                {JSON.stringify(log.details, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Card>
  </div>
);

interface DetailFieldProps {
  label: string;
  value?: string;
  subtitle?: string;
  mono?: boolean;
  children?: React.ReactNode;
}

const DetailField: React.FC<DetailFieldProps> = ({ label, value, subtitle, mono, children }) => (
  <div>
    <label className="text-xs text-gray-500">{label}</label>
    {children || (
      <>
        <p className={`font-medium ${mono ? 'font-mono text-sm' : ''}`}>{value}</p>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </>
    )}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const AuditLogPage: React.FC = () => {
  // Detail modal state
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Filters with URL sync and debounce for search
  const {
    filters,
    debouncedFilters,
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = useFilters<AuditFilters>({
    initialFilters: INITIAL_FILTERS,
    syncUrl: true,
    debounceDelay: 300,
    debounceKeys: ['search'],
  });

  // Pagination
  const pagination = usePagination({
    initialLimit: 20,
    syncUrl: true,
  });

  // Tenants for the filter dropdown. Reference data — a long staleTime, and the
  // key is shared with every other page that lists tenants, so they hit one
  // cache entry instead of one request each.
  const { data: tenants } = useAdminQuery<PaginatedResult<Tenant>>(
    adminKeys.tenants.list({ limit: TENANT_FILTER_LIMIT }),
    ({ signal }) => tenantsApi.list({ limit: TENANT_FILTER_LIMIT }, signal),
    { staleTime: 300_000 },
  );

  // Logs. The query params ARE the cache key — page, limit and every active
  // filter — so a back-navigation to a page already fetched renders from cache
  // and a changed filter is a different entry rather than an overwrite.
  const logQueryParams = useMemo(
    () => buildAuditQueryParams(debouncedFilters, pagination.page, pagination.limit),
    [debouncedFilters, pagination.page, pagination.limit],
  );

  const {
    data: logPage,
    isPending: loading,
    error: logsError,
    refetch,
  } = useAdminQuery<PaginatedResult<AuditLog>>(
    adminKeys.security.audit(logQueryParams),
    ({ signal }) => auditApi.query(logQueryParams, signal),
    { staleTime: 30_000 },
  );

  const logs = logPage?.data;
  const error = logsError ? logsError.message : null;
  const refresh = (): void => {
    void refetch();
  };

  // The server owns the row count; the controller owns the page. Syncing from
  // SETTLED data (rather than from inside the fetcher, as this page used to)
  // means a superseded request can no longer write its total over a newer one.
  useEffect(() => {
    if (logPage) pagination.setTotal(logPage.total);
  }, [logPage?.total]);

  // Statistics. The old cache key named only `tenantId`, so changing a date
  // bound re-fetched into the SAME entry and the header cards showed the
  // previous range's numbers until the TTL expired. All three discriminators
  // are in the key now.
  const statsFilter = useMemo(
    () => ({
      tenantId: debouncedFilters.tenantId || undefined,
      startDate: debouncedFilters.startDate || undefined,
      endDate: debouncedFilters.endDate || undefined,
    }),
    [debouncedFilters.tenantId, debouncedFilters.startDate, debouncedFilters.endDate],
  );

  const { data: stats } = useAdminQuery<AuditLogStats>(
    [...adminKeys.security.all(), 'audit-stats', statsFilter],
    ({ signal }) =>
      auditApi.getStatistics(
        statsFilter.tenantId,
        statsFilter.startDate,
        statsFilter.endDate,
        signal,
      ),
    { staleTime: 60_000 },
  );

  // Reset to page 1 when filters change
  useEffect(() => {
    pagination.goToPage(1);
  }, [debouncedFilters]);

  // Export handler
  const handleExport = async () => {
    try {
      // Same builder as the on-screen list, so the export cannot drift from it;
      // only the page window differs.
      const params = buildAuditQueryParams(filters, 1, EXPORT_ROW_LIMIT);

      const result = await auditApi.query(params);

      const headers = ['Date', 'Action', 'Entity', 'Entity ID', 'User', 'Severity', 'IP Address'];
      const rows = result.data.map((log) => [
        escapeCsvCell(formatDateTime(log.createdAt)),
        escapeCsvCell(log.action),
        escapeCsvCell(log.entityType),
        escapeCsvCell(log.entityId),
        escapeCsvCell(log.performedByEmail),
        escapeCsvCell(log.severity),
        escapeCsvCell(log.ipAddress),
      ]);

      const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url); // Fix: H22 -- prevent memory leak
    } catch (err) {
      setExportError('Export failed: ' + (err as Error).message);
    }
  };

  // Table columns
  const columns: TableColumn<AuditLog>[] = useMemo(() => [
    {
      key: 'createdAt',
      header: 'Date',
      sortable: true,
      render: (log) => (
        <div>
          <span className="text-sm text-gray-900">{formatRelativeTime(log.createdAt)}</span>
          <p className="text-xs text-gray-500">{formatDateTime(log.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      sortable: true,
      render: (log) => <Badge variant={getActionBadgeVariant(log.action)}>{log.action}</Badge>,
    },
    {
      key: 'entityType',
      header: 'Entity',
      sortable: true,
      render: (log) => (
        <div>
          <p className="font-medium text-gray-900">{log.entityType}</p>
          <p className="text-xs text-gray-500 truncate max-w-[120px]">ID: {log.entityId}</p>
        </div>
      ),
    },
    {
      key: 'performedByEmail',
      header: 'User',
      sortable: true,
      render: (log) => (
        <div className="max-w-[180px]">
          <p className="text-sm text-gray-900 truncate">{log.performedByEmail}</p>
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      sortable: true,
      render: (log) => <Badge variant={getSeverityBadgeVariant(log.severity)}>{log.severity}</Badge>,
    },
    {
      key: 'ipAddress',
      header: 'IP',
      render: (log) => <code className="text-xs bg-gray-100 px-2 py-1 rounded">{log.ipAddress}</code>,
    },
    {
      key: 'actions',
      header: '',
      render: (log) => (
        <Button size="sm" variant="ghost" onClick={() => setSelectedLog(log)}>
          Details
        </Button>
      ),
    },
  ], []);

  // Tenant options for filter
  const tenantOptions = useMemo(() => [
    { value: '', label: 'All Tenants' },
    ...(tenants?.data ?? []).map((t) => ({ value: t.id, label: t.name })),
  ], [tenants]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Audit Logs</h1>
          <p className="mt-1 text-sm text-gray-500">
            System activity logs {pagination.total > 0 && `(${pagination.total.toLocaleString()} records)`}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex gap-2">
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </Button>
          <Button variant="outline" onClick={handleExport}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </Button>
        </div>
      </div>

      {/* Export error */}
      {exportError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between">
          <span className="text-red-700 text-sm">{exportError}</span>
          <button onClick={() => setExportError(null)} className="text-red-400 hover:text-red-600 ml-4">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard title="Total Logs" value={stats.totalLogs ?? 0} />
          <StatsCard title="Last 24 Hours" value={stats.last24Hours ?? 0} valueColor="text-blue-600" />
          <StatsCard
            title="Critical Events"
            value={
              Array.isArray(stats.bySeverity)
                ? stats.bySeverity.find((s) => s.severity === 'critical')?.count ?? 0
                : 0
            }
            valueColor="text-red-600"
          />
          <StatsCard
            title="Most Active User"
            value={Array.isArray(stats.topUsers) && stats.topUsers[0]?.email ? stats.topUsers[0].email : '-'}
            subtitle={`${Array.isArray(stats.topUsers) && stats.topUsers[0]?.count ? stats.topUsers[0].count : 0} actions`}
          />
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Search by user, entity, or action..."
              value={filters.search}
              onChange={(e) => setFilter('search', e.target.value)}
              leftIcon={
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
            />
          </div>

          <Select
            value={filters.action}
            onChange={(e) => setFilter('action', e.target.value)}
            options={ACTION_TYPES}
          />

          <Select
            value={filters.severity}
            onChange={(e) => setFilter('severity', e.target.value)}
            options={SEVERITY_LEVELS}
          />

          <Select
            value={filters.entityType}
            onChange={(e) => setFilter('entityType', e.target.value)}
            options={ENTITY_TYPES}
          />

          <Select
            value={filters.tenantId}
            onChange={(e) => setFilter('tenantId', e.target.value)}
            options={tenantOptions}
          />

          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Date</label>
            <Input
              type="date"
              value={filters.startDate}
              onChange={(e) => setFilter('startDate', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">End Date</label>
            <Input
              type="date"
              value={filters.endDate}
              onChange={(e) => setFilter('endDate', e.target.value)}
            />
          </div>
        </div>

        {hasActiveFilters && (
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Clear Filters
            </Button>
          </div>
        )}
      </Card>

      {/* Error State */}
      {error && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-red-600">{error}</p>
          <Button size="sm" variant="outline" onClick={refresh} className="mt-2">
            Retry
          </Button>
        </Card>
      )}

      {/* Loading State */}
      {loading && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-4 text-gray-500">Loading...</p>
        </Card>
      )}

      {/* Table */}
      {!loading && !error && logs && (
        <>
          <Table
            data={logs}
            columns={columns}
            keyExtractor={(log) => log.id}
            emptyMessage="No audit logs found"
          />

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Page {pagination.page} of {pagination.totalPages} ({pagination.total.toLocaleString()} records)
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!pagination.canPrev}
                  onClick={pagination.prevPage}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!pagination.canNext}
                  onClick={pagination.nextPage}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Detail Modal */}
      {selectedLog && (
        <LogDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}
    </div>
  );
};

export default AuditLogPage;
