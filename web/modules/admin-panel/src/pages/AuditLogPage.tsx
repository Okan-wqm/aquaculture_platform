/**
 * Audit Log Page
 *
 * System audit logs with real API integration and mock fallback.
 * Uses custom hooks for data fetching, pagination, and filtering.
 */

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { Card, Button, Input, Select, Badge, Table } from '@aquaculture/shared-ui';
import type { TableColumn } from '@aquaculture/shared-ui';
import { useAsyncData, usePagination, useFilters } from '../hooks';
import { auditApi, tenantsApi } from '../services/adminApi';
import type { AuditLog, AuditLogStats, Tenant } from '../services/adminApi';
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

const SEVERITY_LEVELS = [
  { value: '', label: 'All Severities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

// ============================================================================
// Mock Data (API Fallback)
// ============================================================================

const MOCK_LOGS: AuditLog[] = [
  {
    id: 'log-1',
    action: 'LOGIN',
    entityType: 'User',
    entityId: 'user-1',
    performedBy: 'user-1',
    performedByEmail: 'admin@oceanfarms.com',
    tenantId: 'tenant-1',
    ipAddress: '192.168.1.100',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    severity: 'low',
    metadata: { browser: 'Chrome', os: 'Windows' },
    createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
  },
  {
    id: 'log-2',
    action: 'CREATE',
    entityType: 'User',
    entityId: 'user-5',
    performedBy: 'user-1',
    performedByEmail: 'admin@oceanfarms.com',
    tenantId: 'tenant-1',
    ipAddress: '192.168.1.100',
    userAgent: 'Mozilla/5.0',
    severity: 'medium',
    metadata: { newUserEmail: 'newuser@oceanfarms.com', role: 'MODULE_USER' },
    createdAt: new Date(Date.now() - 30 * 60000).toISOString(),
  },
  {
    id: 'log-3',
    action: 'UPDATE',
    entityType: 'Role',
    entityId: 'role-2',
    performedBy: 'user-1',
    performedByEmail: 'admin@oceanfarms.com',
    tenantId: 'tenant-1',
    ipAddress: '192.168.1.100',
    userAgent: 'Mozilla/5.0',
    severity: 'high',
    metadata: { added: ['farm:delete'], removed: [] },
    createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
  },
  {
    id: 'log-4',
    action: 'LOGIN',
    entityType: 'User',
    entityId: 'unknown',
    performedBy: 'unknown',
    performedByEmail: 'attacker@example.com',
    tenantId: null,
    ipAddress: '10.0.0.55',
    userAgent: 'curl/7.68.0',
    severity: 'critical',
    metadata: { reason: 'Invalid credentials', attempts: 3, blocked: true },
    createdAt: new Date(Date.now() - 5 * 3600000).toISOString(),
  },
  {
    id: 'log-5',
    action: 'SUSPEND',
    entityType: 'Tenant',
    entityId: 'tenant-4',
    performedBy: 'admin-1',
    performedByEmail: 'superadmin@aquaculture.com',
    tenantId: null,
    ipAddress: '172.16.0.1',
    userAgent: 'Mozilla/5.0',
    severity: 'high',
    metadata: { reason: 'Payment overdue', dueAmount: 5000 },
    createdAt: new Date(Date.now() - 24 * 3600000).toISOString(),
  },
];

const MOCK_STATS: AuditLogStats = {
  totalLogs: 1250,
  last24Hours: 85,
  byAction: [
    { action: 'CREATE', count: 120 },
    { action: 'UPDATE', count: 200 },
    { action: 'DELETE', count: 50 },
    { action: 'LOGIN', count: 450 },
  ],
  bySeverity: [
    { severity: 'low', count: 600 },
    { severity: 'medium', count: 400 },
    { severity: 'high', count: 150 },
    { severity: 'critical', count: 100 },
  ],
  topUsers: [
    { userId: 'user-1', email: 'admin@oceanfarms.com', count: 250 },
    { userId: 'user-2', email: 'manager@bluewaters.com', count: 180 },
  ],
};

const MOCK_TENANTS: Tenant[] = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Ocean Farms Ltd', slug: 'oceanfarms', tier: TenantTier.ENTERPRISE, status: TenantStatus.ACTIVE, userCount: 100, farmCount: 10, sensorCount: 150, createdAt: '2024-01-15', updatedAt: '2024-11-26' },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Blue Waters', slug: 'bluewaters', tier: TenantTier.PROFESSIONAL, status: TenantStatus.ACTIVE, userCount: 50, farmCount: 5, sensorCount: 48, createdAt: '2024-03-20', updatedAt: '2024-11-25' },
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

const getSeverityBadgeVariant = (severity: string): 'default' | 'info' | 'warning' | 'error' => {
  const variants: Record<string, 'default' | 'info' | 'warning' | 'error'> = {
    low: 'default',
    medium: 'info',
    high: 'warning',
    critical: 'error',
  };
  return variants[severity] || 'default';
};

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
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
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

          {log.metadata && Object.keys(log.metadata).length > 0 && (
            <div>
              <label className="text-xs text-gray-500">Metadata</label>
              <pre className="text-sm bg-gray-50 p-3 rounded overflow-auto max-h-64">
                {JSON.stringify(log.metadata, null, 2)}
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

  // Fetch tenants for filter dropdown
  const fetchTenants = useCallback(async () => {
    const result = await tenantsApi.list({ limit: 100 });
    return result.data;
  }, []);

  const { data: tenants } = useAsyncData<Tenant[]>(fetchTenants, {
    mockData: MOCK_TENANTS,
    cacheKey: 'audit-tenants',
    cacheTTL: 300000, // 5 minutes
  });

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    const params: Record<string, string> = {
      page: pagination.page.toString(),
      limit: pagination.limit.toString(),
    };

    if (debouncedFilters.action) params.action = debouncedFilters.action;
    if (debouncedFilters.severity) params.severity = debouncedFilters.severity;
    if (debouncedFilters.entityType) params.entityType = debouncedFilters.entityType;
    if (debouncedFilters.tenantId) params.tenantId = debouncedFilters.tenantId;
    if (debouncedFilters.search) params.search = debouncedFilters.search;
    if (debouncedFilters.startDate) params.startDate = debouncedFilters.startDate;
    if (debouncedFilters.endDate) params.endDate = debouncedFilters.endDate;

    const result = await auditApi.query(params);
    pagination.setTotal(result.total);
    return result.data;
  }, [pagination.page, pagination.limit, debouncedFilters]);

  // Filter mock logs for fallback
  const filterMockLogs = useCallback((logs: AuditLog[]): AuditLog[] => {
    let filtered = [...logs];

    if (debouncedFilters.action) {
      filtered = filtered.filter(log => log.action === debouncedFilters.action);
    }
    if (debouncedFilters.severity) {
      filtered = filtered.filter(log => log.severity === debouncedFilters.severity);
    }
    if (debouncedFilters.entityType) {
      filtered = filtered.filter(log => log.entityType === debouncedFilters.entityType);
    }
    if (debouncedFilters.tenantId) {
      filtered = filtered.filter(log => log.tenantId === debouncedFilters.tenantId);
    }
    if (debouncedFilters.search) {
      const term = debouncedFilters.search.toLowerCase();
      filtered = filtered.filter(log =>
        log.performedByEmail?.toLowerCase().includes(term) ||
        log.action.toLowerCase().includes(term) ||
        log.entityType.toLowerCase().includes(term)
      );
    }

    return filtered;
  }, [debouncedFilters]);

  const {
    data: logs,
    loading,
    error,
    refresh,
  } = useAsyncData<AuditLog[]>(fetchLogs, {
    mockData: filterMockLogs(MOCK_LOGS),
    cacheKey: `audit-logs-${JSON.stringify(debouncedFilters)}-${pagination.page}`,
    cacheTTL: 30000,
  });

  // Fetch stats
  const fetchStats = useCallback(async () => {
    return auditApi.getStatistics(
      debouncedFilters.tenantId || undefined,
      debouncedFilters.startDate || undefined,
      debouncedFilters.endDate || undefined
    );
  }, [debouncedFilters.tenantId, debouncedFilters.startDate, debouncedFilters.endDate]);

  const { data: stats } = useAsyncData<AuditLogStats>(fetchStats, {
    mockData: MOCK_STATS,
    cacheKey: `audit-stats-${debouncedFilters.tenantId}`,
    cacheTTL: 60000,
  });

  // Reset to page 1 when filters change
  useEffect(() => {
    pagination.goToPage(1);
  }, [debouncedFilters]);

  // Export handler
  const handleExport = async () => {
    try {
      const params: Record<string, string> = { limit: '10000' };
      if (filters.action) params.action = filters.action;
      if (filters.severity) params.severity = filters.severity;
      if (filters.entityType) params.entityType = filters.entityType;
      if (filters.tenantId) params.tenantId = filters.tenantId;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;

      const result = await auditApi.query(params);

      const headers = ['Date', 'Action', 'Entity', 'Entity ID', 'User', 'Severity', 'IP Address'];
      const rows = result.data.map((log) => [
        formatDateTime(log.createdAt),
        log.action,
        log.entityType,
        log.entityId,
        log.performedByEmail,
        log.severity,
        log.ipAddress,
      ]);

      const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
    } catch (err) {
      alert('Export failed: ' + (err as Error).message);
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
    ...(tenants || []).map((t) => ({ value: t.id, label: t.name })),
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
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
